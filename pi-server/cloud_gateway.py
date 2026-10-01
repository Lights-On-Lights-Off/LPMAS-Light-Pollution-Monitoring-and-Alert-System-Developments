"""The Pi can call only the scoped gateway; database administrator keys are unused."""
import json
import urllib.request


def gateway_request(endpoint, token, action, timeout=20, **values):
    if not endpoint or not token: raise RuntimeError('Scoped Pi cloud access is not provisioned')
    request = urllib.request.Request(endpoint, data=json.dumps({'action':action, **values}).encode(),
        headers={'Authorization':f'Bearer {token}', 'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())
