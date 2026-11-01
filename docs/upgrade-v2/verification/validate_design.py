#!/usr/bin/env python3
"""Validate this design package's examples, not the FlowHub product.
Requires Python 3.10+ and jsonschema. Does not contact any network or MCP.
"""
from __future__ import annotations
import copy
import json
from pathlib import Path
from datetime import datetime, timezone
try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError as exc:
    raise SystemExit('jsonschema is required only for this design validator; no product tests were run.') from exc
ROOT=Path(__file__).resolve().parents[1]
results=[]
def load(path):
    return json.loads((ROOT/path).read_text(encoding='utf-8'))
def check(name, action):
    try:
        action()
        results.append({'name':name,'status':'pass'})
    except Exception as error:
        results.append({'name':name,'status':'fail','error':str(error)})
def require(condition, message):
    if not condition: raise AssertionError(message)
def validate(schema, instance):
    Draft202012Validator(schema,format_checker=FormatChecker()).validate(instance)
for f in sorted((ROOT/'schemas').glob('*.json')):
    check('schema definition: '+f.name,lambda f=f:Draft202012Validator.check_schema(json.loads(f.read_text(encoding='utf-8'))))
for name,schema,example in [
    ('capability','schemas/capability.schema.json','examples/capability.demo.json'),
    ('authoring','schemas/authoring-batch.schema.json','examples/authoring-batch.demo.json'),
    ('test suite','schemas/test-suite.schema.json','examples/test-suite.demo.json')]:
    check('positive example: '+name,lambda s=schema,e=example:validate(load(s),load(e)))
for i,event in enumerate(load('examples/assistant-events.demo.json')):
    check('event example '+str(i),lambda e=event:validate(load('schemas/assistant-event.schema.json'),e))
def rejected(schema, value):
    require(bool(list(Draft202012Validator(schema).iter_errors(value))),'Invalid input unexpectedly accepted')
a=load('examples/authoring-batch.demo.json'); a['operations'][1]={'op':'run_shell','command':'echo not allowed'}
check('negative: no arbitrary shell operation',lambda:rejected(load('schemas/authoring-batch.schema.json'),a))
b=load('examples/authoring-batch.demo.json');b['expectedRevision']=0
check('negative: revision must be positive',lambda:rejected(load('schemas/authoring-batch.schema.json'),b))
c=load('examples/capability.demo.json');c['apiKey']='SYNTHETIC-NOT-A-KEY'
check('negative: capability DTO forbids credential field',lambda:rejected(load('schemas/capability.schema.json'),c))
d=load('examples/test-suite.demo.json');d['mode']='live'
check('negative: mock fixture cannot relabel itself live',lambda:rejected(load('schemas/test-suite.schema.json'),d))
e=load('examples/authoring-batch.demo.json');e['operations'][2]['nodeType']='approval'
check('negative: no new approval node',lambda:rejected(load('schemas/authoring-batch.schema.json'),e))
tools=load('examples/tool-catalog.design.json')
check('tool catalog: one server, 7 legacy + 14 new',lambda:require(tools['serverCount']==1 and len(tools['legacyTools'])==7 and len(tools['authoringAndDiscoveryTools'])==14 and len(set(tools['legacyTools']+tools['authoringAndDiscoveryTools']))==21,'Tool counts mismatch'))
cases=load('examples/acceptance-matrix.design.json'); nl=load('examples/nl-evaluation.design.json')
check('acceptance: 104 distinct not-run cases',lambda:require(len(cases)==104 and len({c['id'] for c in cases})==104 and all(c['status']=='not_run' for c in cases),'Acceptance matrix mismatch'))
check('NL eval: 30 distinct not-run scenarios',lambda:require(len(nl)==30 and len({c['id'] for c in nl})==30 and all(c['status']=='not_run' for c in nl),'NL matrix mismatch'))
check('all Markdown code fences paired',lambda:require(all(sum(line.startswith('```') for line in f.read_text(encoding='utf-8').splitlines())%2==0 for f in ROOT.rglob('*.md')),'Unpaired Markdown code fence'))
check('offline UI has no external script or stylesheet',lambda:require('<script src=' not in (ROOT/'ui/FlowHub_2.0_交互参考.html').read_text(encoding='utf-8') and '<link rel="stylesheet"' not in (ROOT/'ui/FlowHub_2.0_交互参考.html').read_text(encoding='utf-8'),'External resources in prototype'))
report={'scope':'design_examples_only_not_product_tests','generatedAt':datetime.now(timezone.utc).isoformat(),'passed':sum(x['status']=='pass' for x in results),'failed':sum(x['status']=='fail' for x in results),'results':results}
(ROOT/'verification/design-check-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:report[k] for k in ['scope','passed','failed']},ensure_ascii=False))
for result in results:
    if result['status']=='fail':print(result)
raise SystemExit(1 if report['failed'] else 0)
