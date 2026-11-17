// Sends queued notifications with Web Push (VAPID). Runs every minute from pg_cron, or on demand from a signed-in user
// (then it only touches that user's rows). Secrets required: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com).
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL')!, SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SB_URL, SERVICE);
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);

const MAX_RETRIES = 5;
const ESSENTIAL = new Set(['sync', 'security']);           // never silenced by category toggles; critical priority also skips quiet hours
const TAB: Record<string, string> = { spending: 'spend', daily: 'overview', bills: 'bills', budget: 'budget', portfolio: 'portfolio', goals: 'goals', sync: 'sync', reminders: 'overview', quiz: 'quiz', security: 'sync', test: 'overview', support: 'support' };

function localParts(tz: string, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { min: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (t: string) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
// Minutes until quiet hours end (0 if not in quiet hours)
function quietWait(pr: any): number {
  if (!pr.quiet_enabled) return 0;
  const now = localParts(pr.tz).min, s = toMin(pr.quiet_start), e = toMin(pr.quiet_end);
  const inside = s <= e ? (now >= s && now < e) : (now >= s || now < e);
  if (!inside) return 0;
  return ((e - now) + 1440) % 1440 || 1;
}

async function run(onlyUser?: string) {
  const nowIso = new Date().toISOString();
  let q = sb.from('notification_queue').select('*').eq('status', 'queued').lte('scheduled_at', nowIso).lte('next_attempt_at', nowIso).order('created_at').limit(100);
  if (onlyUser) q = q.eq('user_id', onlyUser);
  const { data: items } = await q;
  const out = { sent: 0, failed: 0, retried: 0, skipped: 0 };
  for (const n of items || []) {
    // claim the row so two overlapping runs never send the same notification
    const { data: claimed } = await sb.from('notification_queue').update({ status: 'sending' }).eq('id', n.id).eq('status', 'queued').select('id');
    if (!claimed?.length) continue;
    const finish = (patch: any) => sb.from('notification_queue').update(patch).eq('id', n.id);
    const log = (status: string, extra: any = {}) => sb.from('notification_logs').insert({ user_id: n.user_id, notification_id: n.id, status, ...extra });

    const { data: pr0 } = await sb.from('notification_preferences').select('*').eq('user_id', n.user_id).maybeSingle();
    const pr = pr0 || { master: true, categories: {}, hide_amounts: true, tz: 'Asia/Kolkata', quiet_enabled: false };
    const essential = ESSENTIAL.has(n.category) || n.category === 'test';
    if (!essential && (pr.master === false || pr.categories?.[n.category] === false)) { await finish({ status: 'skipped', error: 'disabled by user' }); out.skipped++; continue; }
    if (n.priority !== 'critical' && !essential) {
      const wait = quietWait(pr);
      if (wait > 0) { await finish({ status: 'queued', next_attempt_at: new Date(Date.now() + wait * 60000).toISOString() }); continue; }
    }
    const { data: subs } = await sb.from('push_subscriptions').select('*').eq('user_id', n.user_id).eq('status', 'active');
    if (!subs?.length) { await finish({ status: 'failed', error: 'no active device' }); await log('failed', { error: 'no active device' }); out.failed++; continue; }

    const payload = JSON.stringify({
      id: n.id, category: n.category, tag: n.dedupe_key.slice(0, 60),
      title: pr.hide_amounts === false ? n.title : 'FinanceOS',
      body: pr.hide_amounts === false ? n.body : n.safe_body,
      url: (n.url && n.url.startsWith('./#n=')) ? n.url : './#n=' + (TAB[n.category] || 'overview'),
    });
    let ok = 0, temporary = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: n.priority === 'critical' ? 'high' : 'normal' });
        ok++; await log('sent', { subscription_id: s.id, device_id: s.device_id });
        await sb.from('push_subscriptions').update({ fail_count: 0, last_active_at: nowIso }).eq('id', s.id);
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) { await sb.from('push_subscriptions').update({ status: 'expired' }).eq('id', s.id); await log('expired', { subscription_id: s.id, device_id: s.device_id, error: `HTTP ${code}` }); }
        else { temporary++; await sb.from('push_subscriptions').update({ fail_count: (s.fail_count || 0) + 1 }).eq('id', s.id); await log('failed', { subscription_id: s.id, device_id: s.device_id, error: String(e?.body || e?.message || e).slice(0, 300) }); }
      }
    }
    if (ok > 0) { await finish({ status: 'sent', sent_at: new Date().toISOString(), error: null }); out.sent++; }   // 'sent' = push service accepted it; 'confirmed' arrives via push-ack
    else if (temporary > 0 && n.retry_count < MAX_RETRIES) {
      const backoffMin = Math.min(60, 2 ** (n.retry_count + 1));                                                   // 2,4,8,16,32 min
      await finish({ status: 'queued', retry_count: n.retry_count + 1, next_attempt_at: new Date(Date.now() + backoffMin * 60000).toISOString(), error: 'temporary failure' }); out.retried++;
    } else { await finish({ status: 'failed', error: temporary ? 'retries exhausted' : 'all subscriptions expired' }); out.failed++; }
  }
  return out;
}

async function cleanup() {
  const d = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
  await sb.from('push_subscriptions').delete().eq('status', 'expired').lt('updated_at', d(30));
  await sb.from('push_subscriptions').delete().gte('fail_count', 10);
  await sb.from('notification_logs').delete().lt('created_at', d(60));
  await sb.from('notification_queue').delete().in('status', ['sent', 'confirmed', 'failed', 'skipped']).lt('created_at', d(90));
  // rows stuck in 'sending' (function crashed) go back to the queue
  await sb.from('notification_queue').update({ status: 'queued' }).eq('status', 'sending').lt('next_attempt_at', new Date(Date.now() - 10 * 60000).toISOString());
}

Deno.serve(async (req) => {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
  let body: any = {}; try { body = await req.json(); } catch (_) { }
  if (token === SERVICE) {
    if (body.cleanup) { await cleanup(); return Response.json({ ok: true, cleaned: true }); }
    return Response.json({ ok: true, ...(await run()) });
  }
  const { data } = await sb.auth.getUser(token);                      // signed-in user: may only flush their own queue
  if (!data?.user) return new Response('unauthorized', { status: 401 });
  return Response.json({ ok: true, ...(await run(data.user.id)) });
});
