import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Menu, X, LayoutDashboard, ArrowLeftRight, Wallet, Target,
  FileText, Sparkles, Plus, CircleHelp, ShieldCheck
} from 'lucide-react';
import { api, getApiBase, setApiBase } from './api';
import { enqueueMutation, flushOutbox, getOutbox, getCachedData, setCachedData, isOnline } from './offline';
import './style.css';
import './live.css';

type User={id:string;email:string;name:string};
type Account={id:string;name:string;type:string;currency:string;openingMinor:string};
type Category={id:string;name:string;type:'income'|'expense'};
type Tx={id:string;type:string;description:string;amountMinor:string;currency:string;occurredAt:string;accountId:string;categoryId:string|null};
type Summary={balances:Array<{accountId:string;currency:string;balanceMinor:string}>;cashFlowByCurrency:Array<{currency:string;incomeMinor:string;expenseMinor:string;netCashFlowMinor:string}>;expenseByCategory:Array<{currency:string;categoryId:string|null;name:string;amountMinor:string}>};

function parseMoney(value:string,currency:string){
  const decimals=currency==='IDR'?0:2,valid=decimals===0?/^[0-9]+$/.test(value):/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value);
  if(!valid)throw new Error(`Enter a valid ${currency} amount.`);
  const [whole,fraction='']=value.split('.');
  return BigInt(whole+fraction.padEnd(decimals,'0'));
}

const TOUR_STEPS = [
  { step: '1 of 4', title: 'Multi-Currency Accounts', desc: 'Create accounts for your bank, physical cash, or e-wallets. Balances are tracked with exact integer arithmetic across IDR, USD, and EUR.' },
  { step: '2 of 4', title: 'Real-Time Transactions', desc: 'Record income and expenses tied directly to your accounts and categories. Balances update immediately with no estimation errors.' },
  { step: '3 of 4', title: 'Monthly Cash Flow', desc: 'Monitor your live summary: total net worth across currencies, monthly income, expenses, and net cash flow at a single glance.' },
  { step: '4 of 4', title: 'Private & Secure', desc: 'Your financial records belong only to your authenticated session. Scoped to your private workspace with zero external tracking.' }
];

function KastrenIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="k-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#10b981"/>
          <stop offset="100%" stopColor="#059669"/>
        </linearGradient>
      </defs>
      <rect x="16" y="14" width="16" height="72" rx="8" fill="url(#k-grad)"/>
      <path d="M32 50 L64 18 C68 14 75 14 79 18 C83 22 83 29 79 33 L48 64 Z" fill="#10b981"/>
      <circle cx="76" cy="21" r="4" fill="#6ee7b7"/>
      <path d="M42 54 L76 84 C80 88 80 95 76 99 C72 103 65 103 61 99 L32 70 Z" fill="#047857"/>
      <polygon points="32,50 48,35 58,47 42,62" fill="#34d399"/>
    </svg>
  );
}

const I18N = {
  en: {
    tagline: 'Take Control of Your Money.',
    registerTitle: 'Create your account',
    loginTitle: 'Money, in balance.',
    name: 'Name',
    email: 'Email',
    password: 'Password',
    wait: 'Please wait…',
    createBtn: 'Create account',
    signInBtn: 'Sign in',
    haveAccount: 'Already registered? Sign in',
    newAccount: 'New to Kastren? Create an account',
    apiServer: '⚙ API Server:',
    defaultServer: 'Default (127.0.0.1:3000)',
    targetHost: 'Target API Host',
    saveTest: 'Save & Test',
    accountCreated: 'Account created. Sign in to continue.'
  },
  id: {
    tagline: 'Kendalikan Keuangan Anda.',
    registerTitle: 'Buat akun Anda',
    loginTitle: 'Keuangan yang seimbang.',
    name: 'Nama',
    email: 'Email',
    password: 'Kata Sandi',
    wait: 'Mohon tunggu…',
    createBtn: 'Buat akun',
    signInBtn: 'Masuk',
    haveAccount: 'Sudah terdaftar? Masuk',
    newAccount: 'Baru di Kastren? Buat akun',
    apiServer: '⚙ Server API:',
    defaultServer: 'Default (127.0.0.1:3000)',
    targetHost: 'Host Server API',
    saveTest: 'Simpan & Uji',
    accountCreated: 'Akun dibuat. Masuk untuk melanjutkan.'
  }
};

function Kastren(){
  const [lang, setLang] = React.useState<'en'|'id'>(() => (localStorage.getItem('kastren_lang') as 'en'|'id') || 'en');
  const [user,setUser]=React.useState<User|null>(null);
  const [mobile,setMobile]=React.useState(false);
  const [tab,setTab]=React.useState<'overview'|'transactions'|'accounts'>('overview');
  const [accounts,setAccounts]=React.useState<Account[]>([]);
  const [categories,setCategories]=React.useState<Category[]>([]);
  const [transactions,setTransactions]=React.useState<Tx[]>([]);
  const [summary,setSummary]=React.useState<Summary|null>(null);
  const [error,setError]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [register,setRegister]=React.useState(false);
  const [transactionType,setTransactionType]=React.useState<'income'|'expense'>('expense');

  // Quick Tour state
  const [showTour,setShowTour]=React.useState(false);
  const [tourStep,setTourStep]=React.useState(0);

  // Server URL config state (for mobile / emulator testing)
  const [showServerConfig,setShowServerConfig]=React.useState(false);
  const [serverUrlInput,setServerUrlInput]=React.useState(getApiBase());
  const [serverMsg,setServerMsg]=React.useState('');

  // Offline sync & outbox state
  const [online, setOnline] = React.useState(isOnline());
  const [pendingSync, setPendingSync] = React.useState(getOutbox().length);
  const [syncing, setSyncing] = React.useState(false);

  const refresh=React.useCallback(async()=>{
    try {
      const [a,c,t,s]=await Promise.all([
        api<Account[]>('/accounts'),
        api<Category[]>('/categories'),
        api<{data:Tx[]}>('/transactions'),
        api<Summary>('/dashboard/summary')
      ]);
      setAccounts(a);setCategories(c);setTransactions(t.data);setSummary(s);
      setCachedData('accounts', a);
      setCachedData('categories', c);
      setCachedData('transactions', t.data);
      setCachedData('summary', s);
      setOnline(true);
    } catch {
      // Offline fallback: load cached data
      const ca = getCachedData<Account[]>('accounts');
      const cc = getCachedData<Category[]>('categories');
      const ct = getCachedData<Tx[]>('transactions');
      const cs = getCachedData<Summary>('summary');
      if (ca) setAccounts(ca);
      if (cc) setCategories(cc);
      if (ct) setTransactions(ct);
      if (cs) setSummary(cs);
      setOnline(false);
    }
    setPendingSync(getOutbox().length);
  },[]);

  React.useEffect(() => {
    const handleOnline = async () => {
      setOnline(true);
      setSyncing(true);
      await flushOutbox((c) => setPendingSync(c));
      setPendingSync(getOutbox().length);
      setSyncing(false);
      await refresh();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refresh]);

  React.useEffect(()=>{
    api<User>('/auth/me').then(async u=>{
      setUser(u);
      await refresh();
      if(!localStorage.getItem('kastren_tour_completed')){
        setShowTour(true);
      }
    }).catch(()=>{});
  },[refresh]);

  async function authSubmit(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();
    setBusy(true);
    setError('');
    const f=new FormData(e.currentTarget);
    try{
      const u=await api<{user:User}>('/auth/login',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password')})});
      setUser(u.user);
      await refresh();
      if(!localStorage.getItem('kastren_tour_completed')){
        setShowTour(true);
        setTourStep(0);
      }
    }catch(err){
      if(register){
        try{
          await api<User>('/auth/register',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password'),name:f.get('name')})});
          setRegister(false);
          setError('Account created. Sign in to continue.');
        }catch(x){
          setError(x instanceof Error?x.message:'Request failed.');
        }
      }else setError(err instanceof Error?err.message:'Request failed.');
    }finally{
      setBusy(false);
    }
  }

  async function createAccount(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();
    const f=new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try{
      await api('/accounts',{method:'POST',body:JSON.stringify({name:f.get('name'),type:f.get('type'),currency:f.get('currency'),openingMinor:Number(f.get('openingMinor')||0)})});
      e.currentTarget.reset();
      await refresh();
    }catch(x){
      setError(x instanceof Error?x.message:'Request failed.');
    }finally{
      setBusy(false);
    }
  }

  async function createCategory(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();
    const f=new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try{
      await api('/categories',{method:'POST',body:JSON.stringify({name:f.get('name'),type:f.get('type')})});
      e.currentTarget.reset();
      await refresh();
    }catch(x){
      setError(x instanceof Error?x.message:'Request failed.');
    }finally{
      setBusy(false);
    }
  }

  async function createTransaction(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();
    const f=new FormData(e.currentTarget);
    const type=f.get('type') as 'income'|'expense';
    const account=accounts.find(a=>a.id===f.get('accountId'));
    const payload = {
      type,
      accountId: String(f.get('accountId')),
      categoryId: f.get('categoryId') ? String(f.get('categoryId')) : null,
      amountMinor: parseMoney(String(f.get('amount')), account?.currency ?? 'IDR').toString(),
      currency: account?.currency ?? 'IDR',
      description: String(f.get('description')),
      occurredAt: new Date(String(f.get('date'))+'T12:00:00').toISOString()
    };
    setBusy(true);
    setError('');
    try{
      if (!online) throw new Error('Offline mode');
      await api('/transactions',{
        method:'POST',
        body:JSON.stringify(payload)
      });
      e.currentTarget.reset();
      await refresh();
    }catch{
      // Enqueue offline mutation and optimistically display
      enqueueMutation({
        endpoint: '/transactions',
        method: 'POST',
        body: payload
      });
      setPendingSync(getOutbox().length);
      const optimisticTx: Tx = {
        id: `offline_${Date.now()}`,
        ...payload,
        description: `${payload.description} [Queued Offline]`
      };
      setTransactions(prev => [optimisticTx, ...prev]);
      e.currentTarget.reset();
      setError('Saved locally. Transaction queued in outbox for background sync.');
    }finally{
      setBusy(false);
    }
  }

  async function triggerSync() {
    setSyncing(true);
    setError('');
    try {
      const { success, failed } = await flushOutbox((c) => setPendingSync(c));
      setPendingSync(getOutbox().length);
      await refresh();
      if (failed > 0) setError(`Synced ${success} items, ${failed} failed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function logout(){
    try{
      await api('/auth/logout',{method:'POST'});
    }finally{
      setUser(null);
      setAccounts([]);
      setTransactions([]);
      setSummary(null);
    }
  }

  async function deleteTx(id: string) {
    if (!window.confirm('Delete this transaction?')) return;
    setBusy(true);
    setError('');
    try {
      await api(`/transactions/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (x) {
      setError(x instanceof Error ? x.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/transactions/export.csv`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to export CSV');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'kastren-transactions.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    }
  }

  function handleSaveServerUrl(e:React.FormEvent){
    e.preventDefault();
    setApiBase(serverUrlInput);
    setServerMsg('Testing connection…');
    fetch(`${getApiBase()}/health`).then(r=>{
      if(r.ok)setServerMsg('Connected successfully!');
      else setServerMsg(`API responded with status ${r.status}`);
    }).catch(err=>{
      setServerMsg(`Connection failed: ${err.message}`);
    });
  }

  function completeTour(){
    setShowTour(false);
    setTourStep(0);
    localStorage.setItem('kastren_tour_completed','true');
  }

  const balance=(a:Account)=>summary?.balances.find(b=>b.accountId===a.id)?.balanceMinor??a.openingMinor;
  const flowValue=(key:'incomeMinor'|'expenseMinor'|'netCashFlowMinor')=>summary?.cashFlowByCurrency.map(x=>money(BigInt(x[key]),x.currency)).join(' · ')||'—';

  if(!user){
    const t = I18N[lang];
    return (
      <main className="live-auth">
        <div className="live-card">
          <div className="live-card-topbar">
            <div className="live-brand"><KastrenIcon size={36}/> <span>KASTREN</span></div>
            <div className="live-lang-switch" role="group" aria-label="Select language">
              <button
                type="button"
                className={`live-lang-btn ${lang === 'en' ? 'active' : ''}`}
                onClick={() => { setLang('en'); localStorage.setItem('kastren_lang', 'en'); }}
                title="English"
              >
                EN
              </button>
              <button
                type="button"
                className={`live-lang-btn ${lang === 'id' ? 'active' : ''}`}
                onClick={() => { setLang('id'); localStorage.setItem('kastren_lang', 'id'); }}
                title="Bahasa Indonesia"
              >
                ID
              </button>
            </div>
          </div>
          <h1>{register?t.registerTitle:t.loginTitle}</h1>
          <p>{t.tagline}</p>
          <form onSubmit={authSubmit} className="live-auth-fields">
            {register&&<label>{t.name}<input name="name" autoComplete="name" required minLength={1} maxLength={100}/></label>}
            <label>{t.email}<input name="email" type="email" autoComplete="email" required maxLength={320}/></label>
            <label>{t.password}<input name="password" type="password" autoComplete={register?'new-password':'current-password'} required minLength={register?12:1} maxLength={128}/></label>
            {error&&<p role="alert" className="live-error">{error}</p>}
            <button className="primary" disabled={busy}>{busy?t.wait:register?t.createBtn:t.signInBtn}</button>
            <button type="button" className="live-text-button" onClick={()=>{setRegister(!register);setError('');}}>{register?t.haveAccount:t.newAccount}</button>
          </form>

          <div className="live-server-toggle">
            <button type="button" className="live-text-button-subtle" onClick={()=>setShowServerConfig(!showServerConfig)}>
              {t.apiServer} {getApiBase() || t.defaultServer}
            </button>
          </div>

          {showServerConfig && (
            <form onSubmit={handleSaveServerUrl} className="live-server-box">
              <label>{t.targetHost}
                <input value={serverUrlInput} onChange={e=>setServerUrlInput(e.target.value)} placeholder="e.g. http://10.0.2.2:3000"/>
              </label>
              <div className="live-preset-row">
                <button type="button" className="secondary live-preset-btn" onClick={()=>setServerUrlInput('http://192.168.100.1:3000')}>Wi-Fi (192.168.100.1)</button>
                <button type="button" className="secondary live-preset-btn" onClick={()=>setServerUrlInput('http://10.0.2.2:3000')}>Emulator (10.0.2.2)</button>
                <button type="button" className="secondary live-preset-btn" onClick={()=>setServerUrlInput('http://127.0.0.1:3000')}>Local (127.0.0.1)</button>
              </div>
              <button type="submit" className="secondary">{t.saveTest}</button>
              {serverMsg && <p className="live-server-msg">{serverMsg}</p>}
            </form>
          )}
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <div className="brand" style={{cursor:'pointer'}} onClick={()=>{setTab('overview');setMobile(false);}}>
          <KastrenIcon size={30}/>
          <span>kastren<small>MONEY, IN BALANCE.</small></span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          <button className={`nav-item ${tab === 'overview' ? 'active' : ''}`} onClick={() => { setTab('overview'); setMobile(false); }}>
            <span className="nav-icon"><LayoutDashboard size={16}/></span>Overview
          </button>
          <button className={`nav-item ${tab === 'transactions' ? 'active' : ''}`} onClick={() => { setTab('transactions'); setMobile(false); }}>
            <span className="nav-icon"><ArrowLeftRight size={16}/></span>Transactions {transactions.length > 0 && <span className="nav-badge">{transactions.length}</span>}
          </button>
          <button className={`nav-item ${tab === 'accounts' ? 'active' : ''}`} onClick={() => { setTab('accounts'); setMobile(false); }}>
            <span className="nav-icon"><Wallet size={16}/></span>Accounts {accounts.length > 0 && <span className="nav-badge">{accounts.length}</span>}
          </button>
          <button className="nav-item" onClick={() => { setTourStep(0); setShowTour(true); setMobile(false); }}>
            <span className="nav-icon"><Target size={16}/></span>Budgets
          </button>
          <button className="nav-item" onClick={() => { exportCsv(); setMobile(false); }}>
            <span className="nav-icon"><FileText size={16}/></span>Reports
          </button>
        </nav>
        <div className="nav-label manage">MANAGE</div>
        <nav>
          <button className="nav-item" onClick={() => { setTourStep(0); setShowTour(true); setMobile(false); }}>
            <span className="nav-icon"><CircleHelp size={16}/></span>Quick Tour
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="upgrade">
            <Sparkles size={16}/>
            <b>A clearer view of money.</b>
            <span>Make your next goal feel closer.</span>
            <button type="button" onClick={() => { setTourStep(0); setShowTour(true); }}>Explore insights <span>↗</span></button>
          </div>
          <div className="user-card">
            <div className="avatar">{user.name.slice(0, 2).toUpperCase()}</div>
            <span>{user.name}<small>{user.email}</small></span>
            <button type="button" onClick={logout} className="live-text-button-subtle" title="Sign out" style={{marginLeft: 'auto'}}>Sign out</button>
          </div>
        </div>
      </aside>

      {mobile && (
        <div
          onClick={() => setMobile(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.38)', zIndex: 4 }}
        />
      )}

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-toggle" onClick={() => setMobile(!mobile)} aria-label="Toggle menu">
            {mobile ? <X size={18}/> : <Menu size={18}/>}
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span> <b>{tab.toUpperCase()}</b>
          </div>
          <div className="top-actions">
            <span className={`live-network-badge ${online ? 'online' : 'offline'}`}>
              {online ? '● Online' : '○ Offline'}
            </span>
            {pendingSync > 0 && (
              <button
                type="button"
                className="secondary live-sync-btn"
                onClick={triggerSync}
                disabled={syncing}
              >
                {syncing ? '…' : `Sync (${pendingSync})`}
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={() => { setTourStep(0); setShowTour(true); }}
              title="Quick Tour"
              aria-label="Quick Tour"
            >
              <CircleHelp size={17}/>
            </button>
            <button type="button" className="profile-btn" onClick={logout} title="Sign out">
              <span className="avatar small">{user.name.slice(0, 2).toUpperCase()}</span>
            </button>
          </div>
        </header>

        <section className="live-welcome">
          <div>
            <span className="live-kicker">YOUR PRIVATE MONEY WORKSPACE</span>
            <h1>Welcome, {user.name}</h1>
            <p>Balances and activity from your saved account.</p>
          </div>
        </section>

        {error && <p role="alert" className="live-error">{error}</p>}

        <section className="live-metrics">
          <article>
            <span>Total balance</span>
            <strong>{summary?.balances.map(x=>money(BigInt(x.balanceMinor),x.currency)).join(' · ')||'—'}</strong>
          </article>
          <article>
            <span>Income this month</span>
            <strong>{flowValue('incomeMinor')}</strong>
          </article>
          <article>
            <span>Expenses this month</span>
            <strong>{flowValue('expenseMinor')}</strong>
          </article>
          <article>
            <span>Net cash flow</span>
            <strong>{flowValue('netCashFlowMinor')}</strong>
          </article>
        </section>

        {(tab === 'overview' || tab === 'accounts') && (
          <div className="live-columns">
            <section className="live-panel">
              <h2>Accounts</h2>
              {accounts.length === 0 && <p className="live-muted">Create your first account to begin.</p>}
              {accounts.map(a => (
                <div className="live-row" key={a.id}>
                  <span>{a.name}<small>{a.type} · {a.currency}</small></span>
                  <strong>{money(BigInt(balance(a)), a.currency)}</strong>
                </div>
              ))}
              <form onSubmit={createAccount} className="live-form">
                <h3>Add account</h3>
                <label>Account name<input name="name" required maxLength={80}/></label>
                <div className="live-form-row">
                  <label>Type<select name="type"><option value="bank">Bank</option><option value="cash">Cash</option><option value="ewallet">E-wallet</option><option value="savings">Savings</option><option value="credit">Credit card</option><option value="other">Other</option></select></label>
                  <label>Currency<select name="currency"><option>IDR</option><option>USD</option><option>EUR</option></select></label>
                </div>
                <label>Opening balance (minor units)<input name="openingMinor" type="number" min="0" step="1" defaultValue="0" required/><small>Minor units; IDR uses whole rupiah.</small></label>
                <button disabled={busy}>Save account</button>
              </form>
            </section>

            <section className="live-panel">
              <h2>New transaction</h2>
              {accounts.length === 0 ? (
                <p className="live-muted">Add an account first. Transactions cannot be created without one.</p>
              ) : (
                <form onSubmit={createTransaction} className="live-form">
                  <label>Type<select name="type" value={transactionType} onChange={e=>setTransactionType(e.target.value as 'income'|'expense')}><option value="expense">Expense</option><option value="income">Income</option></select></label>
                  <label>Account<select name="accountId" required>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</select></label>
                  <label>Category<select name="categoryId" required>{categories.filter(c=>c.type===transactionType).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                  <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required/></label>
                  <label>Description<input name="description" maxLength={120} required/></label>
                  <label>Date<input name="date" type="date" defaultValue={new Date().toISOString().slice(0,10)} required/></label>
                  <button disabled={busy}>Save transaction</button>
                </form>
              )}
              <form onSubmit={createCategory} className="live-form">
                <h3>Add category</h3>
                <label>Category type<select name="type"><option value="expense">Expense</option><option value="income">Income</option></select></label>
                <label>Category name<input name="name" required maxLength={60}/></label>
                <button className="secondary" disabled={busy}>Save category</button>
              </form>
            </section>
          </div>
        )}

        {(tab === 'overview' || tab === 'transactions') && (
          <section className="live-panel live-transactions">
            <div className="live-panel-header">
              <h2>Recent Transactions</h2>
              {transactions.length > 0 && (
                <button type="button" className="secondary live-export-btn" onClick={exportCsv}>
                  Export CSV
                </button>
              )}
            </div>
            {transactions.length === 0 ? (
              <p className="live-muted">No transactions yet.</p>
            ) : (
              transactions.map((t) => (
                <div className="live-row" key={t.id}>
                  <span>
                    {t.description}
                    <small>
                      {new Date(t.occurredAt).toLocaleDateString()} · {t.type}
                    </small>
                  </span>
                  <div className="live-row-actions">
                    <strong>
                      {t.type === 'expense' ? '−' : '+'}
                      {money(BigInt(t.amountMinor), t.currency)}
                    </strong>
                    <button
                      type="button"
                      className="live-icon-btn-danger"
                      title="Delete transaction"
                      onClick={() => deleteTx(t.id)}
                      aria-label={`Delete transaction ${t.description}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
        )}

        <footer className="footer" style={{marginTop: '32px'}}>
          <span>© 2025 Kastren Financial, Inc.</span>
          <span className="secure-status"><ShieldCheck size={13}/> Account-scoped private data</span>
        </footer>
      </main>

      {/* Mobile Dock Navigation */}
      <div className="mobile-dock">
        <button
          type="button"
          className={tab === 'overview' ? 'active' : ''}
          onClick={() => { setTab('overview'); setMobile(false); }}
        >
          <LayoutDashboard size={18}/>Home
        </button>
        <button
          type="button"
          className={tab === 'transactions' ? 'active' : ''}
          onClick={() => { setTab('transactions'); setMobile(false); }}
        >
          <ArrowLeftRight size={18}/>Activity
        </button>
        <button
          type="button"
          className="dock-add"
          onClick={() => { setTab('transactions'); setMobile(false); }}
          aria-label="Add transaction"
        >
          <Plus size={20}/>
        </button>
        <button
          type="button"
          className={tab === 'accounts' ? 'active' : ''}
          onClick={() => { setTab('accounts'); setMobile(false); }}
        >
          <Wallet size={18}/>Accounts
        </button>
        <button
          type="button"
          onClick={() => { setTourStep(0); setShowTour(true); }}
        >
          <CircleHelp size={18}/>Tour
        </button>
      </div>

      {/* Quick Tour Modal */}
      {showTour && (
        <div className="live-tour-backdrop" role="dialog" aria-modal="true">
          <div className="live-tour-modal">
            <button type="button" className="live-tour-close" onClick={completeTour} aria-label="Close tour">✕</button>
            <span className="live-tour-badge">{TOUR_STEPS[tourStep].step}</span>
            <h2 className="live-tour-title">{TOUR_STEPS[tourStep].title}</h2>
            <p className="live-tour-desc">{TOUR_STEPS[tourStep].desc}</p>

            <div className="live-tour-dots">
              {TOUR_STEPS.map((_, i) => (
                <span key={i} className={`live-tour-dot ${i === tourStep ? 'active' : ''}`} />
              ))}
            </div>

            <div className="live-tour-actions">
              <button type="button" className="live-text-button" onClick={completeTour}>Skip</button>
              <div className="live-tour-nav">
                {tourStep > 0 && (
                  <button type="button" className="secondary" onClick={() => setTourStep(s => Math.max(0, s - 1))}>Back</button>
                )}
                {tourStep < TOUR_STEPS.length - 1 ? (
                  <button type="button" className="primary" onClick={() => setTourStep(s => Math.min(TOUR_STEPS.length - 1, s + 1))}>Next</button>
                ) : (
                  <button type="button" className="primary" onClick={completeTour}>Get Started</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="live-foot">Account-scoped data · API-backed · No bank connection</footer>
    </div>
  );
}

function money(amount:bigint,currency:string){
  return new Intl.NumberFormat('id-ID',{style:'currency',currency,maximumFractionDigits:currency==='IDR'?0:2}).format(Number(amount)/(currency==='IDR'?1:100));
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Kastren/></React.StrictMode>);
