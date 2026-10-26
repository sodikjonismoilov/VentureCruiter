import { LoadingState } from './LoadingState';
import { useEffect,useRef,useState } from 'react';
import { GlassSelect } from './GlassSelect';
import { api } from '../lib/api';
import { Conversation } from '../lib/types';
export interface Goal {id:string;conversation_id:string;title:string;objective:string;success_criteria:string;status:string;runs:number;max_runs:number;interval_minutes:number;next_run_at?:string;last_summary?:string;manager_model:string;}
export function GoalsPanel({onClose,rooms,ensureRoom,onOpenWorkspace}:{onClose:()=>void;rooms:Conversation[];ensureRoom:()=>Promise<Conversation>;onOpenWorkspace:(id:string)=>void}){
 const [loading,setLoading]=useState(true);
 const dialog=useRef<HTMLDialogElement>(null);const mutationRevision=useRef(0);const latestLoad=useRef(0);const refreshGoals=useRef<()=>void>(()=>{});const [goals,setGoals]=useState<Goal[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [title,setTitle]=useState('');const [objective,setObjective]=useState('');const [criteria,setCriteria]=useState('');const [room,setRoom]=useState('auto');const [model,setModel]=useState('gpt-6.1-sol');const [interval,setIntervalMinutes]=useState(60);const [runs,setRuns]=useState(3);
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement;
  dialog.current?.showModal();
  let active=true;
  let timer:ReturnType<typeof setTimeout>|undefined;

  async function load(){
   const loadId=++latestLoad.current;
   const revision=mutationRevision.current;
   try{
    const data=await api.getGoals();
    if(active&&loadId===latestLoad.current&&revision===mutationRevision.current){
     setGoals(data);
     setError('');
    }
   }catch(e){
    if(active&&loadId===latestLoad.current&&revision===mutationRevision.current)setError(String(e));
   }finally{
    if(active&&loadId===latestLoad.current)setLoading(false);
   }
   if(active&&loadId===latestLoad.current){
    clearTimeout(timer);
    timer=setTimeout(()=>void load(),5000);
   }
  }

  refreshGoals.current=()=>{clearTimeout(timer);void load();};
  void load();
  return()=>{
   active=false;
   clearTimeout(timer);
   latestLoad.current+=1;
   refreshGoals.current=()=>{};
   dialog.current?.close();
   previous?.focus();
  };
 },[]);
 async function create(e:React.FormEvent){
  e.preventDefault();
  setBusy(true);
  setError('');
  try{
   const conversation_id=room==='auto'?(await ensureRoom()).id:room;
   const g=await api.createGoal({conversation_id,title,objective,success_criteria:criteria,manager_model:model,interval_minutes:interval,max_runs:runs});
   mutationRevision.current+=1;
   setGoals(list=>[g,...list]);
   setTitle('');
   setObjective('');
   setCriteria('');
   refreshGoals.current();
  }catch(e){
   setError(String(e));
  }finally{
   setBusy(false);
  }
 }
 async function change(g:Goal,status:string){
  setBusy(true);
  try{
   const next=await api.setGoalState(g.id,status);
   mutationRevision.current+=1;
   setGoals(list=>list.map(item=>item.id===g.id?next:item));
   setError('');
   refreshGoals.current();
  }catch(e){
   setError(String(e));
  }finally{
   setBusy(false);
  }
 }
 const labels:Record<string,string>={active:'Working toward goal',paused:'Paused',completed:'Complete',blocked:'Needs review',limit_reached:'Run limit reached'};
 return <dialog ref={dialog} className="bot-dialog goals-dialog" aria-labelledby="goals-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><h2 id="goals-title">Give it a goal.</h2><p className="dialog-intro">Your cloud manager works toward a clear outcome, even when this browser is closed.</p><form className="agent-form" onSubmit={create}><div className="agent-form-fields"><div className="goal-list" aria-busy={loading}>{loading?<LoadingState label="Loading your goals…" rows={2}/>:!goals.length&&!error?<p className="field-help">No goals yet. Create your first one below.</p>:null}{goals.map(g=><section key={g.id} className="goal-row"><div><strong>{g.title}</strong><span data-status={g.status}>{labels[g.status]||g.status}</span></div><p>{g.runs} of {g.max_runs} runs · every {g.interval_minutes} minutes</p>{g.last_summary?<p>{g.last_summary}</p>:null}<button type="button" className="btn-secondary" onClick={()=>onOpenWorkspace(g.conversation_id)}>Open workspace</button><details><summary>Goal details</summary><p>{g.objective}</p><p>Done when: {g.success_criteria}</p>{g.next_run_at&&g.status==='active'?<p>Next run: {new Date(g.next_run_at+'Z').toLocaleString()}</p>:null}</details>{g.status==='active'?<button type="button" className="btn-secondary" disabled={busy} onClick={()=>change(g,'paused')}>Pause</button>:['paused','blocked'].includes(g.status)?<button type="button" className="btn-secondary" disabled={busy||g.runs>=g.max_runs} onClick={()=>change(g,'active')}>Resume</button>:null}</section>)}</div><label htmlFor="goal-title">Goal</label><input autoFocus id="goal-title" required maxLength={120} placeholder="Prepare a finished launch plan" value={title} onChange={e=>setTitle(e.target.value)}/><label htmlFor="goal-objective">What should happen?</label><textarea id="goal-objective" required rows={3} maxLength={12000} placeholder="Describe the outcome and the resources it should use." value={objective} onChange={e=>setObjective(e.target.value)}/><label htmlFor="goal-criteria">How will it know it is done?</label><textarea id="goal-criteria" required rows={2} maxLength={2000} placeholder="A measurable result, a finished file, or a verified action." value={criteria} onChange={e=>setCriteria(e.target.value)}/><label htmlFor="goal-room">Workspace</label><GlassSelect id="goal-room" value={room} onChange={e=>setRoom(e.target.value)}><option value="auto">Agent lounge</option>{rooms.filter(r=>r.title!=='Agent lounge').map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</GlassSelect><label htmlFor="goal-manager">Manager</label><GlassSelect id="goal-manager" value={model} onChange={e=>setModel(e.target.value)}><option value="gpt-6.1-sol">GPT-6.1 Sol</option><option value="gpt-6-luna">GPT-6 Luna</option></GlassSelect><label>Time between runs <output>{interval} minutes</output><input aria-label="Goal interval" type="range" min="15" max="1440" step="15" value={interval} onChange={e=>setIntervalMinutes(+e.target.value)}/></label><label>Maximum runs <output>{runs}</output><input aria-label="Goal maximum runs" type="range" min="1" max="20" value={runs} onChange={e=>setRuns(+e.target.value)}/></label><p className="field-help">Starts immediately. Each run uses model credits. It stops when verified complete, blocked, paused, or at its run limit. Interrupted actions are not replayed.</p>{error?<p className="form-error" role="alert">{error.replace(/^Error: /,'')}</p>:null}</div><div className="dialog-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Done</button><button className="btn-primary" disabled={busy}>{busy?'Saving…':'Start goal'}</button></div></form></dialog>;
}
