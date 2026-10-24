"""Narrow, sourced, read-only alternatives to broken public provider tools."""
import json
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser

from app.services.plugins import http_client

JOBHERDER_PRICING_URL = 'https://jobherder.com/pricing'


class PricingMetadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.current = []
        self.documents = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.active = str(dict(attrs).get('type') or '').lower() == 'application/ld+json'
            self.current = []

    def handle_data(self, data):
        if self.active:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            self.documents.append(''.join(self.current))
            self.active = False


def public_offers(html):
    parser = PricingMetadata()
    parser.feed(html)
    offers = []
    for document in parser.documents:
        try:
            records = json.loads(document)
        except ValueError:
            continue
        records = records if isinstance(records, list) else [records]
        for record in records:
            if not isinstance(record, dict) or record.get('@type') != 'Product':
                continue
            if 'jobherder' not in str(record.get('name', '')).casefold():
                continue
            rows = record.get('offers', [])
            rows = rows if isinstance(rows, list) else [rows]
            for row in rows[:20]:
                if not isinstance(row, dict) or row.get('@type') != 'Offer':
                    continue
                name, currency = row.get('name'), row.get('priceCurrency')
                try:
                    price = Decimal(str(row['price']))
                except (KeyError, InvalidOperation, ValueError):
                    continue
                if not price.is_finite() or price < 0 or not isinstance(name, str) or not name.strip():
                    continue
                if not isinstance(currency, str) or not re.fullmatch(r'[A-Z]{3}', currency):
                    continue
                offers.append({'name': name[:160], 'price': str(price), 'currency': currency})
    if not offers:
        raise ValueError('The official pricing page did not publish usable offers.')
    return offers


async def jobherder_website_pricing(plugin_name):
    # Fixed public origin, no saved provider credentials, no redirects, no JS,
    # no registration, checkout, paid search, or assumption about MCP credits.
    async with http_client(timeout=8) as client:
        async with client.stream('GET', JOBHERDER_PRICING_URL, headers={'Accept': 'text/html'}) as response:
            response.raise_for_status()
            if 'text/html' not in response.headers.get('content-type', '').lower():
                raise ValueError('The official pricing page did not return HTML.')
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > 262144:
                    raise ValueError('The official pricing page exceeded the read limit.')
    data = {
        'service': 'Jobherder', 'source_url': JOBHERDER_PRICING_URL,
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'offers': public_offers(body.decode('utf-8', errors='replace')),
        'scope': 'Current public website offers. MCP credit packs and USDC prices were not verified.',
    }
    return {
        'success': True, 'plugin': plugin_name, 'content': json.dumps(data), 'structured_content': data,
        'verification_mode': 'public_website_fallback', 'source_url': JOBHERDER_PRICING_URL,
        'provider_warning': {'code': 'invalid_provider_output',
                             'message': 'The MCP pricing response failed validation; these offers come from the official website.'},
    }
