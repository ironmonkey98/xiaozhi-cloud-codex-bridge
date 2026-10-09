// Real hardware query replay; reuses stored terminal tasks, never starts Codex.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {connectAsync} from 'mqtt';
import {setTimeout as delay} from 'node:timers/promises';
import {loadDotEnv,loadGatewayConfig} from '../src/config.ts';
import {notificationConfigSchema} from '../src/notifications/signal.ts';
import {NotificationOutbox} from '../src/notifications/outbox.ts';
const root=resolve(import.meta.dirname,'..');loadDotEnv(join(root,'.env'));
const c=notificationConfigSchema.parse(JSON.parse(readFileSync(join(root,'config/notify.local.json'),'utf8')));
const db=new DatabaseSync(join(loadGatewayConfig().dataDir,'tasks.sqlite'),{readOnly:true});
const task=db.prepare("SELECT id,updated_at FROM tasks WHERE namespace=? AND status IN ('succeeded','failed','timed_out') ORDER BY id DESC LIMIT 1").get(c.namespace) as {id:number;updated_at:number}|undefined;
if(!task) throw new Error('No terminal task to replay');
const binding=createHash('sha256').update(`${c.namespace}:${c.device_id}`).digest('hex').slice(0,16);
const outbox=new NotificationOutbox(join(root,'data',`notify-${binding}.sqlite`));
outbox.discover(c.namespace,`T-${task.id}`,process.argv.includes('--replay') ? Date.now() : task.updated_at);
const signal=outbox.due()[0];if(!signal) throw new Error('No pending hint available');
const prefix=`devices/${c.device_id}/notify/`,ackTopic=`devices/${c.device_id}/ack`;
const client=await connectAsync(c.url,{...c.gateway,clientId:`query-probe-${Date.now()}`,reconnectPeriod:0,connectTimeout:10000});
let started=false,completed=false,failed=false,served=false;
try {
 await client.subscribeAsync(ackTopic,{qos:1});
 client.on('message',(topic,data)=>{
  if(topic!==ackTopic || data.length>512)return;
  try {
   const ack=JSON.parse(data.toString());
   if(ack.event_id!==signal.event_id || ack.receiver!=='firmware')return;
   console.log(JSON.stringify({event:'firmware_ack',stage:ack.stage,task_id:signal.task_id}));
   if(ack.stage==='query_started')started=true;
   if(ack.stage==='query_failed')failed=true;
   const marked=outbox.acknowledge(ack.event_id,ack.receiver,ack.stage);
   // The production relay may have marked the same batch first.
   completed=marked || (served && ack.stage==='playback_completed') || completed;
  } catch { /* unrelated input */ }
 });
 console.log(JSON.stringify({event:'real_query_probe',task_id:signal.task_id,new_codex_task:false}));
 outbox.sent(signal.event_id);
 await client.publishAsync(prefix+signal.event_id,JSON.stringify(signal),{qos:1,retain:true});
 const end=Date.now()+240_000;let lastRetry=Date.now();
 while(Date.now()<end&&!completed&&!failed) {
  const receipts=outbox.queryServed();
  for(const receipt of receipts)if(receipt.event_id===signal.event_id){
   await client.publishAsync(prefix+receipt.event_id,JSON.stringify({...receipt,type:'query_served'}),{qos:1,retain:true});
   if(!served){console.log(JSON.stringify({event:'gateway_query_served'}));served=true;}
  }
  if(!started&&Date.now()-lastRetry>10000){await client.publishAsync(prefix+signal.event_id,JSON.stringify(signal),{qos:1,retain:true});lastRetry=Date.now();}
  await delay(1000);
 }
 console.log(JSON.stringify({query_and_playback:completed?'PASS':'FAIL',device_query_started:started,physical_audio:'REQUIRES_HUMAN_CONFIRMATION'}));
 if(completed)for(const id of outbox.clearable()){await client.publishAsync(prefix+id,'',{qos:1,retain:true});outbox.cleared(id);}
 else {await client.publishAsync(prefix+signal.event_id,'',{qos:1,retain:true});process.exitCode=1;}
}finally{await client.endAsync();outbox.close();db.close();}
