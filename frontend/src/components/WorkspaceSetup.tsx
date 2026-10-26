import { useEffect, useRef, useState } from 'react';
import { ModelConnection, ModelConnections } from './ModelConnections';
type CloudCheck = { status: string; detail?: { message?: string }; checked_at?: string };
type Runtime = { worker?: boolean; worker_version_matches?: boolean | null; database?: boolean; model_configured?: boolean; model_transport?: string; connected?: boolean; checks?: Record<string, CloudCheck>; can_manage_model_connections?: boolean; model_connections?: ModelConnection[] };
type ConnectionSettings = { models?: { manageUrl?: string } };
const CHECK_LABELS: Record<string, string> = { starter_plugins: 'Starter plugin connections', media_openai: 'OpenAI image generation', fleet: 'Agent orchestration', model: 'GPT-6.1 Sol', fallback: 'GPT-6 Luna', mcp: 'MCP tool call', browser: 'Hosted browser', computer: 'Cloud computer' };
export function WorkspaceSetup({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const checkSequence = useRef(0);
  const [detail, setDetail] = useState<Runtime>({});
  const [status, setStatus] = useState<'checking'|'connected'|'disconnected'|'unavailable'>('checking');
  const [error, setError] = useState('');
  const [omnirouteManageUrl, setOmnirouteManageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [geminiTest, setGeminiTest] = useState<'idle'|'running'|'passed'|'failed'>('idle');
  const [geminiMessage, setGeminiMessage] = useState('');
  const requestStatus = detail.checks?.check_request?.status;
  const pending = submitting || requestStatus === 'pending' || requestStatus === 'running' || detail.model_connections?.some(item => item.state === 'checking');
  async function check() {
    const sequence = ++checkSequence.current;
    try {
      const [response, connectionResponse] = await Promise.all([
        fetch('/api/runtime', { cache: 'no-store' }),
        fetch('/api/connections', { cache: 'no-store' }),
      ]);
      if (!response.ok) throw new Error('Could not refresh cloud status.');
      const data = await response.json();
      const settings = await connectionResponse.json().catch((): ConnectionSettings => ({}));
      if (!mounted.current || sequence !== checkSequence.current) return;
      setDetail(data); setOmnirouteManageUrl(settings.models?.manageUrl || ''); setStatus(data.connected ? 'connected' : 'disconnected');
    }
    catch { if (mounted.current && sequence === checkSequence.current) setStatus('unavailable'); }
  }
  async function runChecks() {
    setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/runtime/checks', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not queue cloud checks.');
      if (!mounted.current) return;
      setDetail(previous => ({ ...previous, checks: { ...previous.checks, check_request: { status: data.status } } }));
      await check();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not queue cloud checks.'); }
    finally { if (mounted.current) setSubmitting(false); }
  }
  async function testGemini() {
    setGeminiTest('running'); setGeminiMessage('');
    try {
      const response = await fetch('/api/runtime/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', model: 'gemini-3.8-flash' }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Gemini could not be verified. Check the OmniRoute provider and try again.');
      if (!mounted.current) return;
      setGeminiTest('passed'); setGeminiMessage('Gemini 3.8 Flash replied through the configured model route.');
    } catch (failure) {
      if (!mounted.current) return;
      setGeminiTest('failed'); setGeminiMessage(failure instanceof Error ? failure.message : 'Gemini could not be verified. Check the provider connection and try again.');
    }
  }
  useEffect(() => { mounted.current = true; const previous = document.activeElement as HTMLElement; dialog.current?.showModal(); void check(); return () => { mounted.current = false; dialog.current?.close(); previous?.focus(); }; }, []);
  useEffect(() => { const timer = setInterval(() => void check(), pending ? 3000 : 5000); return () => clearInterval(timer); }, [pending]);
  const workerUpdating = detail.worker_version_matches === false;
  const modelPassed = detail.checks?.model?.status === 'passed';
  const modelFailed = detail.checks?.model?.status === 'failed';
  return <dialog ref={dialog} className="bot-dialog setup-dialog" aria-labelledby="setup-title" onCancel={onClose}>
    <h2 id="setup-title">Your cloud workspace</h2><p className="dialog-intro">One setup. Then work from any device.</p>
    <div className="agent-form"><div className="agent-form-fields">
      <div className="connection-state" data-state={status}><span className="connection-dot"/><div><strong>{status === 'checking' ? 'Checking connection…' : status === 'unavailable' ? 'Cloud status unavailable' : detail.connected ? detail.worker ? 'Cloud workspace connected' : 'Cloud API connected · worker not ready' : 'Cloud runtime not connected'}</strong><p>{status === 'unavailable' ? 'Could not refresh the connection status. Try again.' : detail.connected ? 'Database and worker readiness are separate from model and tool access.' : 'Agents need a reachable hosted runtime before they can work.'}</p></div></div>
      {detail.model_transport !== 'omniroute' ? <section className="provider-setup" aria-labelledby="gemini-setup-title">
        <h3 id="gemini-setup-title">Connect Gemini</h3>
        <p>Add your Gemini API key in Model access below. We verify it with a short model request and use it directly for Gemini calls.</p>
        <div className="provider-setup-actions">
          <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">Get a Gemini API key</a>
        </div>
        <p className="provider-setup-note">A Google AI Pro or Gemini subscription is not an API key for this app. Gemini API usage has separate quota and billing.</p>
        <div className="provider-test">
          <button type="button" className="btn-secondary" disabled={geminiTest === 'running'} onClick={() => void testGemini()}>{geminiTest === 'running' ? 'Testing Gemini…' : geminiTest === 'passed' ? 'Test again' : 'Test Gemini connection'}</button>
          {geminiMessage ? <p data-state={geminiTest} role={geminiTest === 'failed' ? 'alert' : 'status'}>{geminiMessage}</p> : null}
        </div>
        <p className="provider-test-cost">Testing sends one short request to Gemini and may use your provider quota.</p>
      </section> : null}
      <ol className="setup-steps">
        <li><strong>{detail.database ? 'Database connected' : 'Connect your database'}</strong><p>Agent history stays in a separate PostgreSQL schema.</p></li>
        <li><strong>{modelPassed ? 'Model response verified' : detail.model_configured ? 'Model connection configured' : 'Enable model access'}</strong><p>{detail.model_transport === 'omniroute' ? modelFailed ? 'The OmniRoute check failed. Your saved tasks remain available; verify the connection again to see its current state.' : 'Model requests use your existing OmniRoute connection. Provider account limits still apply.' : modelFailed ? 'The last model check failed. Check the configured provider connection, then verify again.' : 'Model requests use your configured provider connection.'}</p></li>
        <li><strong>{detail.worker ? 'Cloud worker responding' : workerUpdating ? 'Cloud worker updating' : 'Cloud worker not ready'}</strong><p>{workerUpdating ? 'The worker is still on an earlier release. This status updates automatically when the current release starts.' : 'A running cloud worker continues queued tasks when this page closes or your laptop is off.'}</p></li>
      </ol>
      {detail.can_manage_model_connections ? <ModelConnections items={(detail.model_connections || []).filter(item => detail.model_transport === 'omniroute' || item.id === 'gemini' || item.id === 'xai')} canManage workerReady={!!detail.worker} onQueued={check} omniroute={detail.model_transport === 'omniroute'} manageUrl={omnirouteManageUrl}/> : null}
      <details className="advanced-settings"><summary>Live check results</summary><p className="field-help">Run checks makes small model requests, reads public documentation, opens a test page, and starts then stops a test computer. It can use provider credits and cloud compute.</p><ul className="setup-steps">{Object.entries(CHECK_LABELS).map(([name, label]) => { const result = detail.checks?.[name]; return <li key={name}><strong>{label}: {result?.status || 'Not checked'}</strong>{result?.checked_at ? <p>Last checked {new Date(result.checked_at).toLocaleString()}</p> : null}{result?.detail?.message ? <p>{result.detail.message}</p> : null}</li>; })}</ul></details>
      <details className="advanced-settings"><summary>Host in your AWS account</summary><p className="field-help">Sign in to AWS and create a private workspace you own. The template provisions one EC2 host, an encrypted 60 GB disk, PostgreSQL, Redis, HTTPS, and an owner login. AWS bills these resources to your account.</p><ol className="setup-steps"><li><strong>Prepare your account</strong><p>Choose a domain you control. Save your OpenAI API key as an SSM SecureString named /grokbot/openai-api-key in the AWS region you will use.</p></li><li><strong>Review and launch</strong><p>Download the template. In CloudFormation choose Create stack → Upload a template file. Select your VPC and public subnet, enter your domain, review the resources and IAM permissions, then create the stack.</p></li><li><strong>Open your private workspace</strong><p>Point your domain to the HostAddress stack output. Sign in as owner using the password in the LoginPasswordParameter SSM SecureString. Credentials stay in your AWS account. Stack creation waits for the API and database to respond.</p></li></ol><a className="setup-doc-link" href="/setup/aws-workspace.json" download>Download AWS template</a><a className="setup-doc-link" href="https://console.aws.amazon.com/cloudformation/home#/stacks/create/template" target="_blank" rel="noreferrer">Sign in to AWS and create workspace</a><p className="field-help">This is a single-host deployment. Configure backups before relying on it. Creating a stack is the approval step; downloading this template creates no resources.</p></details>
      {detail.model_transport === 'omniroute' && detail.can_manage_model_connections ? <details className="advanced-settings"><summary>Use provider subscriptions</summary><p className="field-help">In OmniRoute, connect supported accounts under Dashboard → Providers. Requests then use the OmniRoute gateway key and the subscription's provider route; the app does not create or reveal a vendor API key. ChatGPT uses Codex, Claude uses Claude Code, and Gemini can use an Antigravity Google connection. Connect xAI OAuth in OmniRoute for Grok where the installed route supports it. Provider quota and model availability remain controlled by each account.</p>{omnirouteManageUrl ? <a className="setup-doc-link" href={omnirouteManageUrl} target="_blank" rel="noreferrer">Open OmniRoute provider setup</a> : <p className="field-help">A provider management link is not configured for this workspace. The installation owner can set OMNIROUTE_DASHBOARD_URL to the OmniRoute Providers page.</p>}</details> : null}
      <details className="advanced-settings"><summary>Deployment guide</summary><p className="field-help">The managed deployment includes a private backend and persistent worker. A successful check verifies only the operation named.</p><a className="setup-doc-link" href="https://github.com/HIveAppDeveloper/open-grokbot/blob/main/SETUP.md" target="_blank" rel="noreferrer">Open setup instructions</a></details>
      {pending ? <p role="status" className="field-help">Cloud checks {requestStatus === 'pending' ? 'queued' : 'running'}. You can close this window; the worker continues.</p> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </div><div className="dialog-actions"><button className="btn-secondary" onClick={() => void check()}>Refresh</button><button disabled={pending || !detail.worker} className="btn-secondary" onClick={() => void runChecks()}>{pending ? 'Verifying…' : 'Verify models and tools'}</button><button className="btn-primary" onClick={onClose}>Done</button></div></div>
  </dialog>;
}
