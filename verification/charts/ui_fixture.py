"""Synthetic local chart UI only; never use this as a submission backend."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).parent
CID='11111111-1111-4111-8111-111111111111'
MID='22222222-2222-4222-8222-222222222222'
BASE=f'/api/conversations/{CID}/attachments/{MID}'


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_GET(self):
        if self.path.startswith(BASE+'/'):
            index=int(self.path.rsplit('/',1)[-1])
            extension,mime=[('png','image/png'),('svg','image/svg+xml'),('csv','text/csv')][index]
            body=(ROOT/f'bar.{extension}').read_bytes()
        else:
            mime='application/json'
            data=[]
            if self.path=='/api/bots':data=[{'id':'fixture-agent','name':'Chart assistant','role':'Analyst','status':'idle','llm_provider':'openai','llm_model':'gpt-6.1-sol','tools_enabled':['media'],'system_prompt':'Synthetic chart fixture'}]
            elif self.path=='/api/conversations':data=[{'id':CID,'title':'Agent lounge','is_group':True,'bot_ids':['fixture-agent']}]
            elif '/sync' in self.path:data={'messages':[{'id':MID,'conversation_id':CID,'sender_type':'bot','sender_bot_id':'fixture-agent','message_type':'text','content':f'Here is the requested chart. This preview uses **illustrative data**.\n\n![Quarterly revenue, illustrative data]({BASE}/0)\n\n[Editable SVG]({BASE}/1) · [Download CSV]({BASE}/2)','created_at':'2026-10-24T20:00:00Z'}],'tasks':[]}
            elif self.path=='/api/runtime':data={'model_configured':True,'model_transport':'omniroute'}
            elif self.path=='/api/workspace/settings':data={}
            body=json.dumps(data).encode()
        self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)


if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',3221),Handler).serve_forever()
