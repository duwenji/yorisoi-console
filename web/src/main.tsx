import { StrictMode, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes, useNavigate } from 'react-router';
import type { Schemas } from '@yorisoi-console/api-types';
import { createApi, describe, type Api } from './api';
import { createAuth, loadConfig, type Auth, type ConsoleConfig } from './auth';
import { AuditPage } from './pages/audit';
import { ChannelPage } from './pages/channel';
import { CollectionReviewPage, OperatorCollectionPage } from './pages/collection-review';
import { HomePage } from './pages/home';
import { KeysPage } from './pages/keys';
import { PublicationsPage } from './pages/publications';
import { ReviewPage, ReviewQueuePage } from './pages/review';
import { PublisherPage, PublishersPage } from './pages/publishers';
import { TransfersPage } from './pages/transfers';
import { OperatorStudio, ProviderStudio } from './pages/studio';
import { OperatorNotes } from './pages/notes';
import { OperatorAreas } from './pages/areas';
import { PublisherChannel, PublisherChannels } from './pages/publisher/channels';
import { PublisherCollection, PublisherCollections } from './pages/publisher/collections';
import { PublisherHome } from './pages/publisher/home';
import { PublisherKeys } from './pages/publisher/keys';
import { PublisherSettings } from './pages/publisher/settings';
import './style.css';

interface Session {
  config: ConsoleConfig;
  auth: Auth;
  api: Api;
  me: Schemas['Me'];
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('no session');
  return session;
}

// The code in the callback URL can be redeemed once; StrictMode runs effects twice in development.
let finishing: Promise<string> | undefined;

function Callback({ auth }: { auth: Auth }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  useEffect(() => {
    finishing ??= auth.finishSignIn();
    finishing.then((to) => navigate(to, { replace: true }), (e: unknown) => setError(String(e)));
  }, [auth, navigate]);
  return error ? <p className="error">ログインできませんでした: {error}</p> : <p>ログインしています…</p>;
}

/** Signs in if needed, then loads who the user is. */
function Gate({ config, auth, children }: { config: ConsoleConfig; auth: Auth; children: (s: Session) => ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    (async () => {
      if (!(await auth.user())) return auth.signIn();
      const api = createApi(auth);
      const { data } = await api.GET('/api/me');
      if (data) setSession({ config, auth, api, me: data });
    })().catch((e: unknown) => setError(describe(e)));
  }, [auth, config]);
  if (error) return <p className="error">{error}</p>;
  if (!session) return <p>読み込んでいます…</p>;
  return <SessionContext.Provider value={session}>{children(session)}</SessionContext.Provider>;
}

const NAV: [string, string][] = [
  ['/', '概要'],
  ['/review', '審査'],
  ['/publications', '公開'],
  ['/keys', '署名鍵・鍵セット'],
  ['/publishers', '提供者'],
  ['/transfers', '鍵の移し替え'],
  ['/channels', 'チャンネル'],
  ['/studio', 'スタジオ'],
  ['/notes', '一言'],
  ['/areas', '置けない区画'],
  ['/audit', '操作の記録'],
];

const PUBLISHER_NAV: [string, string][] = [
  ['/', '概要'],
  ['/channels', 'チャンネル'],
  ['/collections', '素材集'],
  ['/studio', 'スタジオ'],
  ['/keys', '鍵'],
  ['/settings', '設定'],
];

function Shell({ session }: { session: Session }) {
  const operator = session.me.roles.includes('operator');
  const publisher = session.me.roles.includes('publisher');
  const nav = operator ? NAV : publisher ? PUBLISHER_NAV : [];
  return (
    <div className="shell">
      <header>
        <strong>チャンネル管理</strong>
        {session.config.environment !== 'prod' && <span className="badge">開発用</span>}
        <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}</nav>
        <button className="link" onClick={() => void session.auth.signOut()}>ログアウト</button>
      </header>
      <main>
        {operator ? (
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/review" element={<ReviewQueuePage />} />
            <Route path="/review/:channelId/:submissionId" element={<ReviewPage />} />
            <Route path="/review/collections/:collectionId/:submissionId" element={<CollectionReviewPage />} />
            <Route path="/collections/:collectionId" element={<OperatorCollectionPage />} />
            <Route path="/publications" element={<PublicationsPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/publishers" element={<PublishersPage />} />
            <Route path="/publishers/:publisherId" element={<PublisherPage />} />
            <Route path="/transfers" element={<TransfersPage />} />
            <Route path="/channels" element={<ChannelPage />} />
            <Route path="/channels/:channelId" element={<ChannelPage />} />
            <Route path="/studio" element={<OperatorStudio />} />
            <Route path="/notes" element={<OperatorNotes />} />
            <Route path="/areas" element={<OperatorAreas />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<p>このページはありません。</p>} />
          </Routes>
        ) : publisher ? (
          <Routes>
            <Route path="/" element={<PublisherHome />} />
            <Route path="/channels" element={<PublisherChannels />} />
            <Route path="/channels/:channelId" element={<PublisherChannel />} />
            <Route path="/collections" element={<PublisherCollections />} />
            <Route path="/collections/:collectionId" element={<PublisherCollection />} />
            <Route path="/studio" element={<ProviderStudio />} />
            <Route path="/keys" element={<PublisherKeys />} />
            <Route path="/settings" element={<PublisherSettings />} />
            <Route path="*" element={<p>このページはありません。</p>} />
          </Routes>
        ) : (
          <section>
            <h1>このアカウントでは使えません</h1>
            <p>運営の担当者にも提供者にもなっていません。登録の確認が済んでいるか確かめ、一度ログアウトしてからログインし直してください。</p>
          </section>
        )}
      </main>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState<{ config: ConsoleConfig; auth: Auth }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    loadConfig().then((config) => setReady({ config, auth: createAuth(config) }), (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!ready) return null;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/callback" element={<Callback auth={ready.auth} />} />
        <Route path="*" element={<Gate config={ready.config} auth={ready.auth}>{(s) => <Shell session={s} />}</Gate>} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
