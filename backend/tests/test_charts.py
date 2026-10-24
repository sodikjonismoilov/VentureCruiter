"""Chart contracts: real output bytes, numeric semantics, bounded untrusted data."""
import asyncio
import base64
import csv
import io
import threading
import xml.etree.ElementTree as ET

from PIL import Image
import pytest

from app.services.tools.charts import ChartRequest, create_chart, domain

NS = {'svg':'http://www.w3.org/2000/svg'}


def request(**changes):
    return {'chart_type':'bar','title':'Quarterly revenue','labels':['Q1','Q2','Q3'],
            'series':[{'name':'Revenue','values':[10,15,12]}],
            'data_origin':'user_provided','x_label':'Quarter','y_label':'Revenue ($ thousands)',**changes}


def run(data):
    return asyncio.run(create_chart(data,'test-agent'))


def files(result):
    return {item['mime']:base64.b64decode(item['data']) for item in result['_attachments']}


@pytest.mark.parametrize('kind',['bar','line','area','scatter','pie'])
def test_all_chart_types_return_real_png_accessible_svg_and_exact_csv(kind):
    data=request(chart_type=kind,labels=['1','2','3'] if kind=='scatter' else ['Q1','Q2','Q3'])
    result=run(data)
    assert result['success'] is True
    assert (result['row_count'],result['series_count'])==(3,1)
    exported=files(result)
    image=Image.open(io.BytesIO(exported['image/png']))
    assert image.format=='PNG' and image.size==(1280,820)
    assert image.getextrema()!=((255,255),(255,255),(255,255))
    svg=ET.fromstring(exported['image/svg+xml'])
    assert svg.attrib['role']=='img'
    assert svg.find('svg:title',NS).text=='Quarterly revenue'
    assert 'Revenue 15' in svg.find('svg:desc',NS).text
    rows=list(csv.reader(io.StringIO(exported['text/csv'].decode('utf-8-sig'))))
    assert rows[0]==['Quarter','Revenue']
    assert [float(row[1]) for row in rows[1:]]==[10,15,12]
    assert all(len(blob)<5*1024*1024 for blob in exported.values())


@pytest.mark.parametrize('changes',[
    {'labels':['only-one']},
    {'series':[{'name':'Empty','values':[None,None,None]}]},
    {'series':[{'name':'Bad','values':[1,float('nan'),3]}]},
    {'series':[{'name':'Bad','values':[1,float('inf'),3]}]},
    {'series':[{'name':'Bad','values':[True,2,3]}]},
    {'labels':['x']*201},
    {'series':[{'name':str(i),'values':[1,2,3]} for i in range(9)]},
    {'chart_type':'scatter','labels':['x','y','z']},
    {'chart_type':'scatter','labels':['1','nan','3']},
    {'chart_type':'pie','series':[{'name':'Bad','values':[1,-2,3]}]},
    {'chart_type':'pie','series':[{'name':'Bad','values':[0,0,0]}]},
    {'chart_type':'pie','series':[{'name':'Bad','values':[1,None,3]}]},
    {'chart_type':'pie','series':[{'name':'A','values':[1,2,3]},{'name':'B','values':[3,4,5]}]},
    {'data_origin':'tool_result','source':''},
    {'code':'import os'},
    {'title':'Bad\x00label'},
    {'source':'bad\ud800source'},
    {'labels':[]},
])
def test_invalid_data_produces_actionable_error_without_fake_downloads(changes):
    result=run(request(**changes))
    assert result['success'] is False
    assert result['error'].startswith('Chart data is invalid.')
    assert '_attachments' not in result


def test_svg_text_is_escaped_and_csv_neutralizes_formula_strings():
    title='<script>alert("x")</script>'
    result=run(request(title=title,labels=['=HYPERLINK("https://evil.invalid")','@SUM(A1:A3)','normal'],
                       series=[{'name':'+formula','values':[-10,0,12]}]))
    exported=files(result)
    svg=ET.fromstring(exported['image/svg+xml'])
    assert svg.find('svg:title',NS).text==title
    assert svg.findall('.//svg:script',NS)==[]
    assert svg.findall('.//svg:image',NS)==[]
    rows=list(csv.reader(io.StringIO(exported['text/csv'].decode('utf-8-sig'))))
    assert rows[0][1]=="'+formula"
    assert rows[1][0].startswith("'=HYPERLINK")
    assert rows[2][0]=="'@SUM(A1:A3)"
    assert float(rows[1][1])==-10
    assert all('/' not in item['name'] for item in result['_attachments'])


def test_missing_line_observations_are_gaps_and_csv_blanks():
    result=run(request(chart_type='line',labels=['A','B','C','D','E'],
                       series=[{'name':'Observed','values':[1,2,None,4,5]}]))
    exported=files(result)
    svg=ET.fromstring(exported['image/svg+xml'])
    data_lines=[node for node in svg.findall('svg:polyline',NS) if node.attrib.get('stroke-width')=='3']
    assert len(data_lines)==2
    rows=list(csv.reader(io.StringIO(exported['text/csv'].decode('utf-8-sig'))))
    assert rows[3]==['C','']
    assert 'Observed missing' in svg.find('svg:desc',NS).text


def test_multiline_source_text_stays_valid_and_csv_keeps_original_labels():
    result=run(request(labels=['North\nAmerica','Europe','Asia'],source='Provided\nby user',data_origin='tool_result'))
    assert result['success'] is True
    exported=files(result)
    ET.fromstring(exported['image/svg+xml'])
    rows=list(csv.reader(io.StringIO(exported['text/csv'].decode('utf-8-sig'))))
    assert rows[1][0]=='North\nAmerica'


def test_negative_and_zero_bar_domains_include_truthful_zero_baseline():
    for values in [[-10,-5],[-10,20],[0,0],[.001,.002]]:
        low,high,ticks=domain(values,True)
        assert low<=min(0,*values) and high>=max(0,*values)
        assert 0 in ticks
    result=run(request(series=[{'name':'Change','values':[-10,0,20]}]))
    assert result['success'] is True


def test_illustrative_numbers_are_labeled_and_sourced_numbers_need_provenance():
    svg=ET.fromstring(files(run(request(data_origin='illustrative')))['image/svg+xml'])
    assert 'Illustrative data — not actual observations' in ''.join(svg.itertext())
    svg=ET.fromstring(files(run(request(data_origin='tool_result',source='https://example.com/report')))['image/svg+xml'])
    assert 'Source: https://example.com/report' in ''.join(svg.itertext())


def test_rendering_does_not_block_async_worker_heartbeat(monkeypatch):
    import app.services.tools.charts as charts
    entered,release=threading.Event(),threading.Event()
    actual=charts.render_chart
    def slow(spec):
        entered.set()
        assert release.wait(5)
        return actual(spec)
    monkeypatch.setattr(charts,'render_chart',slow)
    async def check():
        rendering=asyncio.create_task(charts.create_chart(request(),'test-agent'))
        for _ in range(200):
            if entered.is_set():break
            await asyncio.sleep(.005)
        assert entered.is_set()
        heartbeat=asyncio.create_task(asyncio.sleep(.01,result='alive'))
        assert await asyncio.wait_for(heartbeat,.5)=='alive'
        release.set()
        assert (await rendering)['success'] is True
    asyncio.run(check())


def test_large_supported_plot_stays_bounded_and_retains_every_csv_observation():
    data=request(chart_type='line',labels=[str(i) for i in range(200)],
                 series=[{'name':f'Series {n}','values':[float(i+n) for i in range(200)]} for n in range(8)])
    result=run(data)
    assert result['success'] is True
    rows=list(csv.reader(io.StringIO(files(result)['text/csv'].decode('utf-8-sig'))))
    assert len(rows)==201 and len(rows[-1])==9
    assert [float(value) for value in rows[-1][1:]]==[float(199+n) for n in range(8)]
