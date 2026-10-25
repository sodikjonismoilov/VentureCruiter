import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppSession, readSignedPayload } from '../../lib/auth-server';
import { internalPathWithSearch } from '../../lib/canonical-app';
import ProspectingWorkspace from '../../components/ProspectingWorkspace';
import '../cipher/cipher.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cypher Prospecting',
  description: 'Website-first company prospecting, powered by Open GrokBot.',
  icons: { icon: '/cypher-mark.svg', apple: '/cypher-mark.svg' },
};

export default function ProspectingPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  let session: AppSession | null = null;
  try { session = readSignedPayload<AppSession>(cookies().get('grokbot_session')?.value); } catch { session = null; }
  if (process.env.REQUIRE_USER_AUTH === 'true' && !session) {
    const returnTo = internalPathWithSearch('/prospecting', searchParams);
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  return <ProspectingWorkspace accountId={session?.sub}/>;
}
