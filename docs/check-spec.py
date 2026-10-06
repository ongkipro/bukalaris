#!/usr/bin/env python3
"""Validate local proposed API references and key headless boundaries, not runtime."""
from pathlib import Path
import re
import yaml

root = Path(__file__).resolve().parent
spec = yaml.safe_load((root / 'openapi.yaml').read_text())
errors = []
def require(ok, message):
    if not ok:
        errors.append(message)
def walk(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == '$ref':
                require(child.startswith('#/'), f'Unexpected external reference: {child}')
                target = spec
                try:
                    for segment in child[2:].split('/'):
                        target = target[segment.replace('~1', '/').replace('~0', '~')]
                except (KeyError, TypeError):
                    errors.append(f'Broken reference: {child}')
            else:
                walk(child)
    elif isinstance(value, list):
        for child in value:
            walk(child)
walk(spec)
operations = {}
for path, item in spec['paths'].items():
    host = 'bos' if path.startswith('/admin/') else 'checkout' if path.startswith('/checkout/') else 'app'
    require(item.get('servers') == [{'url': f'https://{host}.bukalaris.com/api/v1'}],
            f'Wrong proposed API origin: {path}')
    for method, operation in item.items():
        if method not in {'get', 'post', 'put', 'patch', 'delete'}:
            continue
        operation_id = operation['operationId']
        require(operation_id not in operations, f'Duplicate operation: {operation_id}')
        operations[operation_id] = operation
        require(operation.get('x-status') == 'proposed', f'Missing proposal status: {operation_id}')
        names = {v.get('name') for v in operation.get('parameters', []) if v.get('in') == 'path'}
        require(set(re.findall(r'{([^}]+)}', path)) == names, f'Path parameters mismatch: {path}')
        if path.startswith('/checkout/'):
            require(operation['security'] == [{'checkoutSession': []}], f'Checkout auth leak: {path}')
        if path.startswith('/seller/') or path.startswith('/admin/'):
            require(all('storefrontToken' not in x and x for x in operation['security']), f'Privileged auth leak: {path}')
require('/storefront/carts/{cart_id}/checkout' not in spec['paths'], 'Storefront still owns checkout submit')
require('createCheckoutHandoff' in operations and 'submitCheckout' in operations, 'Missing checkout boundary')
require('createStorefrontChannel' in operations and 'revokeStorefrontChannel' in operations, 'Missing channel lifecycle')
for operation_id in ('listSystemLogs', 'getSystemLog'):
    require(operations[operation_id].get('x-required-capability') == 'logs.read',
            f'Missing restricted log capability: {operation_id}')
require(any(p.get('name') == 'environment' for p in operations['listSystemLogs']['parameters']),
        'Missing log environment filter')
log_event = spec['components']['schemas']['LogEvent']
require({'service', 'environment', 'release_revision', 'operation_id'} <= set(log_event['required']),
        'Missing diagnostic function attribution')
require(log_event.get('additionalProperties') is False, 'Log projection permits arbitrary fields')
require({'source_status', 'last_observed_at'} <= set(spec['components']['schemas']['LogEventList']['required']),
        'Log list cannot distinguish source completeness and freshness')
for file in root.glob('*.md'):
    for target in re.findall(r'\]\(([^)]+)\)', file.read_text()):
        if '://' not in target and not target.startswith('#'):
            require((file.parent / target.split('#')[0]).exists(), f'Broken file link: {file.name}: {target}')
if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS proposed API: {len(spec["paths"])} paths, {len(operations)} operations; refs, auth boundaries and local file links')
