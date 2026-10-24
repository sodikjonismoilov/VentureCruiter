"""Bounded, deterministic charts from supplied numbers. No network or sandbox.

The existing artifact pipeline persists _attachments and returns authenticated
downloads. Never accept executable code, HTML, external images, or file paths.
"""
from __future__ import annotations

import asyncio
import base64
import csv
from html import escape
import io
import math
from pathlib import Path
import re
import textwrap
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

Label = Annotated[str, Field(min_length=1, max_length=100)]
Number = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1e15, le=1e15)]
COLORS = ['#202124', '#35618d', '#34755f', '#9d531b', '#7a4b87', '#78652b', '#9b4453', '#3b777f']
INK, MUTED, GRID = '#202124', '#55575c', '#e5e6e8'
FONT_DIR = Path(__file__).resolve().parents[2] / 'data' / 'chart_fonts'


class ChartSeries(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: Annotated[str, Field(min_length=1, max_length=80)]
    values: list[Number | None] = Field(min_length=1, max_length=200)


class ChartRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    chart_type: Literal['bar', 'line', 'area', 'scatter', 'pie']
    title: Annotated[str, Field(min_length=1, max_length=140)]
    labels: list[Label] = Field(min_length=1, max_length=200)
    series: list[ChartSeries] = Field(min_length=1, max_length=8)
    data_origin: Literal['user_provided', 'tool_result', 'illustrative']
    source: str = Field(default='', max_length=300)
    x_label: str = Field(default='', max_length=80)
    y_label: str = Field(default='', max_length=80)
    note: str = Field(default='', max_length=300)

    @model_validator(mode='after')
    def valid_data(self):
        texts = [self.title,self.source,self.x_label,self.y_label,self.note,*self.labels,*(item.name for item in self.series)]
        if any((ord(char)<32 and char not in '\t\n\r') or 0xD800<=ord(char)<=0xDFFF or ord(char) in {0xFFFE,0xFFFF} for text in texts for char in text):
            raise ValueError('Chart text must not contain invalid XML control characters or malformed Unicode.')
        if any(len(item.values) != len(self.labels) for item in self.series):
            raise ValueError('Each series must have exactly one value per label; use null for missing observations.')
        if len({item.name for item in self.series}) != len(self.series):
            raise ValueError('Give every series a distinct name.')
        if not any(value is not None for item in self.series for value in item.values):
            raise ValueError('Supply at least one observed number; missing values are not zero.')
        if self.chart_type == 'bar' and len(self.labels) > 24:
            raise ValueError('Bar charts support up to 24 categories. Aggregate explicitly or use a line chart.')
        if self.chart_type == 'pie':
            if len(self.series) != 1 or len(self.labels) > 12:
                raise ValueError('Pie charts require one series and at most 12 categories. Use bars for larger comparisons.')
            values = self.series[0].values
            if any(value is None or value < 0 for value in values) or sum(values) <= 0:
                raise ValueError('Pie values must be observed nonnegative numbers with a positive total.')
        if self.chart_type == 'scatter':
            try:
                xs = [float(label) for label in self.labels]
            except ValueError:
                raise ValueError('Scatter labels must be numeric x coordinates.') from None
            if any(not math.isfinite(value) or abs(value) > 1e15 for value in xs):
                raise ValueError('Scatter x coordinates must be finite numbers between -1e15 and 1e15.')
        if self.data_origin == 'tool_result' and not self.source.strip():
            raise ValueError('Give the actual source for data obtained through a tool.')
        return self


CHART_PARAMETERS = ChartRequest.model_json_schema()
CHART_PARAMETERS['description'] = (
    'Render supplied data as a chart. Values must come from the user or actual tool results. '
    'Use data_origin=illustrative for invented demonstration numbers; the chart will label them. '
    'Scatter labels are numeric x coordinates. Null values create gaps, never zeros. '
    'Returns an inline PNG preview, accessible editable SVG, and spreadsheet-safe CSV downloads.'
)


def number(value: float) -> str:
    if value == 0:
        return '0'
    if abs(value) >= 1e7 or abs(value) < .001:
        return f'{value:.3g}'
    return f'{value:,.5f}'.rstrip('0').rstrip('.')


def domain(values, include_zero=False):
    low, high = min(values), max(values)
    if include_zero:
        low, high = min(0, low), max(0, high)
    if low == high:
        delta = abs(low) * .1 or 1
        low, high = low - delta, high + delta
    rough = (high - low) / 5
    power = 10 ** math.floor(math.log10(rough))
    step = next(candidate * power for candidate in (1, 2, 2.5, 5, 10) if candidate * power >= rough)
    low, high = math.floor(low / step) * step, math.ceil(high / step) * step
    ticks = [low + index * step for index in range(round((high - low) / step) + 1)]
    return low, high, ticks


class Canvas:
    """One set of geometric drawing operations produces SVG and PNG together."""
    def __init__(self, width, height, title, description):
        from PIL import Image, ImageDraw, ImageFont
        self.image = Image.new('RGB', (width, height), 'white')
        self.draw = ImageDraw.Draw(self.image)
        self.font = ImageFont
        self.fonts = {}
        self.width, self.height = width, height
        self.svg = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title description">',
            f'<title id="title">{escape(title)}</title><desc id="description">{escape(description)}</desc>',
            '<rect width="100%" height="100%" fill="white"/>',
        ]

    def text(self, x, y, value, size=16, color=INK, anchor='start', bold=False):
        value = str(value).replace('\r',' ').replace('\n',' ').replace('\t',' ')
        key = (size,bold)
        if key not in self.fonts:
            self.fonts[key] = self.font.truetype(str(FONT_DIR / f'inter-latin-{"semibold" if bold else "regular"}.ttf'),size=size)
        font = self.fonts[key]
        self.draw.text((x, y), value, font=font, fill=color, anchor={'start': 'ls', 'middle': 'ms', 'end': 'rs'}[anchor])
        self.svg.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="Inter,Arial,sans-serif" font-size="{size}" font-weight="{600 if bold else 400}" fill="{color}" text-anchor="{anchor}">{escape(value)}</text>')

    def line(self, points, color=INK, width=2):
        self.draw.line(points, fill=color, width=width, joint='curve')
        self.svg.append(f'<polyline points="{" ".join(f"{x:.2f},{y:.2f}" for x, y in points)}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"/>')

    def rect(self, x, y, width, height, color, label=''):
        self.draw.rectangle((x, y, x + width, y + height), fill=color)
        self.svg.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{width:.2f}" height="{height:.2f}" fill="{color}"><title>{escape(label)}</title></rect>')

    def circle(self, x, y, radius, color, label=''):
        self.draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color, outline='white', width=1)
        self.svg.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius}" fill="{color}" stroke="white"><title>{escape(label)}</title></circle>')

    def polygon(self, points, color):
        self.draw.polygon(points, fill=color)
        self.svg.append(f'<polygon points="{" ".join(f"{x:.2f},{y:.2f}" for x,y in points)}" fill="{color}"/>')

    def slice(self, cx, cy, radius, start, end, color, label):
        self.draw.pieslice((cx-radius,cy-radius,cx+radius,cy+radius), start=start, end=end, fill=color, outline='white', width=2)
        # Sampling also handles a 360-degree single-slice pie without SVG arc ambiguity.
        count = max(2, math.ceil((end-start) / 2))
        points = [(cx,cy)] + [(cx+radius*math.cos(math.radians(start+(end-start)*i/count)),cy+radius*math.sin(math.radians(start+(end-start)*i/count))) for i in range(count+1)]
        self.svg.append(f'<polygon points="{" ".join(f"{x:.2f},{y:.2f}" for x,y in points)}" fill="{color}" stroke="white" stroke-width="2"><title>{escape(label)}</title></polygon>')

    def export(self):
        png = io.BytesIO()
        self.image.save(png, format='PNG', optimize=True)
        return png.getvalue(), (''.join(self.svg) + '</svg>').encode('utf-8')


def safe_csv_text(value):
    # Spreadsheet formula injection must not become executable on CSV import.
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r', '\n')) or value.startswith(('\t','\r','\n')) else value


def csv_bytes(spec):
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    writer.writerow([safe_csv_text(spec.x_label or 'Category')] + [safe_csv_text(item.name) for item in spec.series])
    for index, label in enumerate(spec.labels):
        writer.writerow([safe_csv_text(label)] + ['' if item.values[index] is None else repr(item.values[index]) for item in spec.series])
    return ('\ufeff' + output.getvalue()).encode('utf-8')


def wrapped(value, width, lines=2):
    return textwrap.wrap(value, width=max(3,width), max_lines=lines, placeholder='…') or ['']


def render_chart(spec: ChartRequest):
    width, height = (1280, 820)
    if spec.chart_type == 'bar':
        width = max(width, min(1600, 240 + len(spec.labels) * 58))
    origin = {'user_provided': 'User-provided data', 'tool_result': f'Source: {spec.source}', 'illustrative': 'Illustrative data — not actual observations'}[spec.data_origin]
    description = f'{spec.chart_type.title()} chart. {origin}. ' + '; '.join(
        f'{label}: ' + ', '.join(f'{item.name} {"missing" if item.values[i] is None else number(item.values[i])}' for item in spec.series)
        for i, label in enumerate(spec.labels)
    )
    canvas = Canvas(width, height, spec.title, description)
    title_lines = wrapped(spec.title, 70, 2)
    for index, line in enumerate(title_lines):
        canvas.text(66, 62 + index * 34, line, 28, bold=True)
    canvas.text(66, 76 + len(title_lines) * 34, origin[:150], 15, MUTED)
    footer_y = height - 42
    for index,line in enumerate(wrapped(spec.note or 'Download the CSV for full labels, exact values, and missing observations.', 125, 2)):
        canvas.text(66, footer_y + index * 19, line, 13, MUTED)

    if spec.chart_type == 'pie':
        total = sum(spec.series[0].values)
        start, cx, cy, radius = -90, 365, 435, 230
        palette = COLORS + ['#a8617c','#686d9b','#806849','#53714a']
        for index,(label,value) in enumerate(zip(spec.labels,spec.series[0].values)):
            end = start + value / total * 360
            if value:
                canvas.slice(cx,cy,radius,start,end,palette[index],f'{label}: {number(value)} ({value/total:.1%})')
                if value / total >= .06:
                    angle=math.radians((start+end)/2)
                    canvas.text(cx+radius*.67*math.cos(angle),cy+radius*.67*math.sin(angle)+6,f'{value/total:.0%}',17,'white','middle',True)
            y = 220 + index * 38
            canvas.rect(695,y-14,12,12,palette[index])
            canvas.text(720,y,wrapped(label,34,1)[0],16)
            canvas.text(width-66,y,number(value),16,MUTED,'end')
            start=end
        canvas.text(365,710,f'Total: {number(total)}',18,INK,'middle')
        return canvas.export()

    left, right, top, bottom = 112, width - 70, 230, 650
    values = [value for item in spec.series for value in item.values if value is not None]
    low, high, ticks = domain(values, spec.chart_type in {'bar','area'})
    y = lambda value: bottom - (value-low)/(high-low)*(bottom-top)
    for tick in ticks:
        position = y(tick)
        canvas.line([(left,position),(right,position)],GRID,1)
        canvas.text(left-16,position+5,number(tick),14,MUTED,'end')
    canvas.text(left,top-16,wrapped(spec.y_label,60,1)[0],14,MUTED)
    if low <= 0 <= high:
        canvas.line([(left,y(0)),(right,y(0))],'#a6a8ad',1)
    for index,item in enumerate(spec.series):
        lx = left + (index % 4) * ((right-left)/4)
        ly = top - 63 + (index // 4) * 25
        canvas.rect(lx,ly-12,12,12,COLORS[index])
        canvas.text(lx+21,ly,wrapped(item.name,26,1)[0],14)
    count = len(spec.labels)
    if spec.chart_type == 'scatter':
        xs = [float(label) for label in spec.labels]
        xlow,xhigh,xticks=domain(xs)
        x = lambda index: left+(xs[index]-xlow)/(xhigh-xlow)*(right-left)
        for tick in xticks:
            canvas.text(left+(tick-xlow)/(xhigh-xlow)*(right-left),bottom+30,number(tick),14,MUTED,'middle')
    else:
        group_width=(right-left)/count
        x=lambda index: left+group_width*(index+.5)
        step=1 if spec.chart_type=='bar' else max(1,math.ceil(count/10))
        for index,label in enumerate(spec.labels):
            if index % step and index != count-1:
                continue
            for line_index,line in enumerate(wrapped(label, min(16,max(3,int((group_width if step==1 else (right-left)/10)/7))),2)):
                canvas.text(x(index),bottom+27+line_index*17,line,12,MUTED,'middle')
    canvas.text((left+right)/2,737,wrapped(spec.x_label,90,1)[0],15,MUTED,'middle')
    foreground = []
    for series_index,item in enumerate(spec.series):
        color=COLORS[series_index]
        if spec.chart_type=='bar':
            bar_width=group_width*.74/len(spec.series)
            for index,value in enumerate(item.values):
                if value is None:
                    continue
                bx=x(index)-group_width*.37+series_index*bar_width
                canvas.rect(bx,min(y(value),y(0)),max(1,bar_width-2),abs(y(value)-y(0)),color,f'{spec.labels[index]}, {item.name}: {number(value)}')
                if count<=8 and len(spec.series)<=2:
                    canvas.text(bx+bar_width/2,y(value)-8 if value>=0 else y(value)+18,number(value),13,INK,'middle')
            continue
        segments,segment=[],[]
        for index,value in enumerate(item.values):
            if value is None:
                if segment:segments.append(segment)
                segment=[]
            else:
                segment.append((index,value))
        if segment:segments.append(segment)
        for segment in segments:
            points=[(x(index),y(value)) for index,value in segment]
            if spec.chart_type=='area' and len(points)>1:
                # Opaque, lightly tinted fills keep PNG/SVG equivalent.
                rgb=tuple(int(color[i:i+2],16) for i in (1,3,5))
                tint='#'+''.join(f'{round(channel*.18+255*.82):02x}' for channel in rgb)
                canvas.polygon([(points[0][0],y(0))]+points+[(points[-1][0],y(0))],tint)
            if spec.chart_type=='area':
                foreground.append((points,segment,color))
                continue
            if spec.chart_type!='scatter' and len(points)>1:
                canvas.line(points,color,3)
            for (index,value),(px,py) in zip(segment,points):
                canvas.circle(px,py,4 if count<=50 or spec.chart_type=='scatter' else 2,color,f'{spec.labels[index]}, {item.name}: {number(value)}')
    for points,segment,color in foreground:
        if len(points)>1:
            canvas.line(points,color,3)
        for (index,value),(px,py) in zip(segment,points):
            canvas.circle(px,py,4 if count<=50 else 2,color,f'{spec.labels[index]}: {number(value)}')
    return canvas.export()


async def create_chart(arguments: dict, bot_id: str) -> dict:
    """Tool contract compatible with the existing generated-file pipeline."""
    try:
        spec = ChartRequest.model_validate(arguments)
    except ValidationError as error:
        return {'success':False,'error':'Chart data is invalid. ' + '; '.join(item['msg'] for item in error.errors(include_input=False,include_url=False)[:3])}
    try:
        png, svg = await asyncio.to_thread(render_chart, spec)
        filename = re.sub(r'[^a-z0-9]+','-',spec.title.lower()).strip('-')[:60] or 'chart'
        files=[(filename+'.png','image/png',png),(filename+'.svg','image/svg+xml',svg),(filename+'.csv','text/csv',csv_bytes(spec))]
        return {'success':True,'title':spec.title,'chart_type':spec.chart_type,'data_origin':spec.data_origin,
                'row_count':len(spec.labels),'series_count':len(spec.series),
                'message':'Chart rendered from the supplied numbers. In your final answer, display the chart with ![chart title](returned PNG file URL) and link the editable SVG and CSV file URLs. Use only the actual returned attachment URLs. Missing observations remain gaps.',
                '_attachments':[{'name':name,'mime':mime,'data':base64.b64encode(data).decode(),**({'disposition':'attachment'} if mime!='image/png' else {})} for name,mime,data in files]}
    except (ValueError, OSError, OverflowError):
        return {'success':False,'error':'The chart could not render. Check the labels and numeric range; no files were created.'}
