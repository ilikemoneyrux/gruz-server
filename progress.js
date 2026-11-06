// Osiągnięcia i Gruz Pass (karnet sezonowy) – od serwera 1.8.0.
//
// Osiągnięcia: dodatkowe odznaki z paskiem postępu i jednorazową nagrodą XP. Trafiają do tej samej listy
// co stare odznaki (u.badges), więc widać je na profilu /u/<nick>, w karcie gracza i na Discordzie.
//
// Gruz Pass: co miesiąc (strefa serwera) 30 poziomów. XP do karnetu to całe XP zdobyte w tym miesiącu
// (gra, zadania dzienne, osiągnięcia). Nagrody darmowe dostaje każdy, nagrody Premium – gracz, który
// wpisał kod "pass:premium" (np. kupiony w Tebexie). Premium działa do końca bieżącego miesiąca.
// Nagrody (kosmetyki) odblokowują się same po wejściu na poziom.

const PASS_TIERS = 30;
const PASS_XP = 120; // XP na poziom karnetu (30 × 120 = 3600 XP w miesiącu)
const DEFAULT_PASS = {
  free: { 10: 'name:fire', 30: 'trail:stars' },
  premium: { 1: 'name:neon', 5: 'trail:sparks', 10: 'back:backpack', 15: 'head:crown', 20: 'pet:crystal', 25: 'back:jetpack', 30: 'cape:galaxy' },
};
const PASS_CODE = 'pass:premium';

function setup(ctx) {
  const { db, save, xpOf, levelOf, hoursOf, dayKey, dayBefore, catalog, sendTo } = ctx;

  // ---------------- osiągnięcia ----------------
  // prog(u) -> [ile jest, ile trzeba]; xp – jednorazowa nagroda
  const n = (v) => Number(v) || 0;
  const ACH = [
    { id: 'hours50', pl: '50 godzin w grze', en: '50 hours played', xp: 150, prog: (u) => [hoursOf(u), 50] },
    { id: 'hours250', pl: '250 godzin w grze', en: '250 hours played', xp: 500, prog: (u) => [hoursOf(u), 250] },
    { id: 'friends10', pl: 'Popularny (10 znajomych)', en: 'Popular (10 friends)', xp: 150, prog: (u) => [u.friends.length, 10] },
    { id: 'slayer500', pl: 'Pogromca (500 killi)', en: 'Destroyer (500 kills)', xp: 300, prog: (u) => [n(u.stats?.kills), 500] },
    { id: 'streak7', pl: 'Tydzień z rzędu', en: '7-day streak', xp: 150, prog: (u) => [n(u.streakBest), 7] },
    { id: 'streak30', pl: 'Miesiąc z rzędu', en: '30-day streak', xp: 600, prog: (u) => [n(u.streakBest), 30] },
    { id: 'quests50', pl: '50 zadań dziennych', en: '50 daily quests', xp: 250, prog: (u) => [n(u.questsDone), 50] },
    { id: 'party10', pl: 'Dusza towarzystwa (10 party)', en: 'Party animal (10 parties)', xp: 120, prog: (u) => [n(u.partiesJoined) + n(u.partiesLed), 10] },
    { id: 'chatter', pl: 'Gaduła (100 wiadomości)', en: 'Chatterbox (100 messages)', xp: 80, prog: (u) => [n(u.dmsSent), 100] },
    { id: 'collector5', pl: 'Kolekcjoner (5 kosmetyków)', en: 'Collector (5 cosmetics)', xp: 120, prog: (u) => [(u.unlocked || []).filter((k) => k !== 'all').length, 5] },
    { id: 'collector15', pl: 'Wielki kolekcjoner (15 kosmetyków)', en: 'Big collector (15 cosmetics)', xp: 300, prog: (u) => [(u.unlocked || []).filter((k) => k !== 'all').length, 15] },
    { id: 'level25', pl: 'Poziom 25', en: 'Level 25', xp: 0, prog: (u) => [levelOf(u).level, 25] },
    { id: 'level50', pl: 'Poziom 50', en: 'Level 50', xp: 0, prog: (u) => [levelOf(u).level, 50] },
    { id: 'top3', pl: 'Podium tygodnia', en: 'Weekly podium', xp: 200, prog: (u) => [u.bestWeekly && u.bestWeekly <= 3 ? 1 : 0, 1] },
    { id: 'passMax', pl: 'Gruz Pass: poziom 30', en: 'Gruz Pass: tier 30', xp: 0, prog: (u) => [passTier(u), PASS_TIERS] },
    { id: 'login30', pl: 'Stały bywalec (30 dni)', en: 'Regular (30 days)', xp: 300, prog: (u) => [n(u.loginTotal), 30] },
  ];
  // jako odznaki (ta sama lista co BADGES w server.js)
  const asBadges = ACH.map((a) => ({ id: a.id, pl: a.pl, en: a.en, test: (u) => { const [c, g] = a.prog(u); return c >= g; } }));

  /** Jednorazowe XP za nowe osiągnięcia (wołane z updateBadges dla świeżo zdobytych) */
  function rewardXp(u, ids) {
    u.achXp = u.achXp || [];
    let xp = 0;
    for (const id of ids) {
      const a = ACH.find((x) => x.id === id);
      if (!a || !a.xp || u.achXp.includes(id)) continue;
      u.achXp.push(id);
      u.bonusXp = (u.bonusXp || 0) + a.xp;
      xp += a.xp;
    }
    // XP za osiągnięcia nie liczy się do Gruz Pass (inaczej weterani dostaliby kilka poziomów naraz po aktualizacji)
    if (xp) { const p = passOf(u); p.xp0 = (p.xp0 || 0) + xp; save(); }
    return xp;
  }
  const xpFor = (id) => ACH.find((x) => x.id === id)?.xp || 0;

  /** Pełna lista dla launchera: stare odznaki (bez paska) + osiągnięcia z postępem */
  function achievementsView(u, BADGES) {
    const have = new Set(u.badges || []);
    const old = BADGES.filter((b) => !ACH.some((a) => a.id === b.id) && b.id !== 'staff')
      .map((b) => ({ id: b.id, names: { pl: b.pl, en: b.en }, done: have.has(b.id), progress: null, goal: null, xp: 0 }));
    const fresh = ACH.map((a) => {
      const [c, g] = a.prog(u);
      return { id: a.id, names: { pl: a.pl, en: a.en }, done: have.has(a.id) || c >= g, progress: Math.min(g, Math.floor(c)), goal: g, xp: a.xp };
    });
    return [...old, ...fresh];
  }

  // ---------------- Gruz Pass ----------------
  const monthKey = () => dayKey().slice(0, 7);
  function monthEnd() {
    const [y, m] = monthKey().split('-').map(Number);
    let t = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 3 * 3600_000; // okolice północy w Europie
    while (dayKey(t).slice(0, 7) === monthKey()) t += 15 * 60_000;
    return t;
  }
  const rewards = () => {
    const cfg = db.promo?.pass || {};
    const pick = (o, d) => (o && typeof o === 'object' ? o : d);
    return { free: pick(cfg.free, DEFAULT_PASS.free), premium: pick(cfg.premium, DEFAULT_PASS.premium) };
  };
  function passOf(u) {
    const m = monthKey();
    // needBase: launcher jeszcze nie przysłał statystyk – start liczymy od pierwszych (stare godziny nie dają poziomów)
    if (!u.pass || u.pass.m !== m) { u.pass = { m, xp0: xpOf(u), premium: false, needBase: u.stats?.totalMs === undefined }; save(); }
    return u.pass;
  }
  /** Po pierwszych statystykach z launchera: punkt startu karnetu = obecne XP */
  function passRebase(u) {
    const p = passOf(u);
    if (p.needBase) { p.needBase = false; p.xp0 = xpOf(u); save(); }
  }
  const passXp = (u) => Math.max(0, xpOf(u) - (passOf(u).xp0 || 0));
  function passTier(u) { return Math.min(PASS_TIERS, Math.floor(passXp(u) / PASS_XP)); }

  /** Odblokowuje nagrody za osiągnięte poziomy. Zwraca listę nowych kosmetyków. */
  function passCheck(u) {
    const p = passOf(u);
    const tier = passTier(u);
    const r = rewards();
    const fresh = [];
    const give = (key) => { if (key && catalog.exists(key) && !u.unlocked.includes(key)) { u.unlocked.push(key); fresh.push(key); } };
    for (let t = 1; t <= tier; t++) {
      give(r.free[t]);
      if (p.premium) give(r.premium[t]);
    }
    if (fresh.length) {
      save();
      for (const key of fresh) sendTo(u.uuid, { t: 'unlocked', cosmetic: key, unlocked: u.unlocked, pass: true });
    }
    return fresh;
  }

  /** Nagrody karnetu bez danych gracza (galeria na stronie) */
  function rewardList() {
    const r = rewards();
    const out = [];
    for (let t = 1; t <= PASS_TIERS; t++) if (r.free[t] || r.premium[t]) out.push({ tier: t, free: r.free[t] || null, premium: r.premium[t] || null });
    return out;
  }

  function passView(u) {
    const p = passOf(u);
    const xp = passXp(u);
    const tier = passTier(u);
    const list = rewardList();
    return {
      month: p.m, endsAt: monthEnd(), tiers: PASS_TIERS, perTier: PASS_XP, tier, xp,
      inTier: tier >= PASS_TIERS ? PASS_XP : xp - tier * PASS_XP, premium: !!p.premium, rewards: list,
    };
  }

  /** Kod Premium: aktywuje karnet na bieżący miesiąc */
  function activatePremium(u) {
    const p = passOf(u);
    if (p.premium) return { error: 'PASS_OWNED' };
    p.premium = true;
    p.premiumAt = Date.now();
    save();
    passCheck(u);
    return { ok: true };
  }

  // ---------------- codzienna nagroda za logowanie (od 1.8.0) ----------------
  // Dzień 1–7 w kółko; każdy dzień daje XP (liczy się do Gruz Pass), dzień 7 – dużo więcej. Pominięty dzień = od nowa.
  const DAILY = () => (Array.isArray(db.promo?.dailyXp) && db.promo.dailyXp.length === 7 ? db.promo.dailyXp.map(Number) : [30, 40, 50, 60, 80, 100, 250]);
  function dailyView(u) {
    const today = dayKey();
    const d = u.login || { n: 0, last: '' };
    const claimed = d.last === today;
    const alive = claimed || d.last === dayBefore(today);
    const streak = alive ? d.n : 0;
    return { claimed, day: claimed ? d.n : (streak % 7) + 1, streak, rewards: DAILY(), total: u.loginTotal || 0 };
  }
  function dailyClaim(u) {
    const v = dailyView(u);
    if (v.claimed) return { error: 'DAILY_CLAIMED' };
    const xp = v.rewards[v.day - 1] || 0;
    u.login = { n: v.day, last: dayKey() };
    u.loginTotal = (u.loginTotal || 0) + 1;
    u.bonusXp = (u.bonusXp || 0) + xp;
    save();
    return { ok: true, xp, day: v.day };
  }

  return { ACH, asBadges, rewardList, passRebase, dailyView, dailyClaim, rewardXp, xpFor, achievementsView, passView, passCheck, passTier, activatePremium, PASS_CODE, monthKey };
}

module.exports = { setup, PASS_CODE, PASS_TIERS, PASS_XP, DEFAULT_PASS };
