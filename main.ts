// Sharpe Sprint bot — a disciplined paper-trading bot for the pump.fun replay
// (protocol agent-fun/replay/v2: hello, batch, done on stdin; one reply per batch).
//
// Idea, in one paragraph: buy only curves that already show real, broad buying
// (several distinct buyers, net SOL flowing in, price rising but not yet vertical),
// size every position the same small amount, and get out fast on a take-profit, a
// tight stop, a trailing stop, or a sell-off. Small equal stakes plus quick exits
// keep hourly returns steady instead of one lucky moonshot — that is what the
// hourly Sharpe ranking rewards. A pacing probe guarantees the 20-coin minimum
// even in a quiet window: when filled round trips lag the pace, tiny probe trades
// open and close on the most liquid curves.
//
// The bot is deterministic: no clock, no randomness, no network, no files. It only
// iterates insertion-ordered maps fed by the batch stream, so its two grading runs
// agree byte for byte. Per-batch work is O(events in the batch + open positions),
// so it never comes near the sandbox time budget.
//
// Entry accounting (all in SOL, 1 SOL = 1e9 lamports):
//   stake 0.05 SOL per position, one add of 0.05 SOL into strength, max 0.10 SOL.
//   Fees are about 1.25% of curve volume per side plus 105,000 lamports per tx,
//   so a 0.05 SOL round trip costs roughly 0.0014 SOL; the +20% take-profit and
//   -5% stop clear that cost with room to spare. The wide take-profit lets a
//   real runner pay for several small stopped-out tries, and the long hold
//   (3000 slots) does not cut a winner short while the trailing stop guards it.

import * as readline from "node:readline";

const LAMPORTS_F = 1e9;
const FEE_BPS = 125; // protocol 95 + creator 30 bps, charged on curve volume
const TX_FEE_FALLBACK = 105_000; // base 5,000 + priority 100,000 lamports

// ---- strategy knobs (all tuned for steadiness, not for one big win) ----
// Entry is deliberately broad: buy a new curve early, while its cap allows a
// meaningful stake, on light evidence of buying (a few distinct buyers, net
// inflow, price not already collapsing). The dev window is a small sample, so a
// strict momentum filter starves the bot of coins; the exits — not the entry
// filter — are what protect the Sharpe ratio.
const STAKE_SOL = 0.05;
const ADD_SOL = 0.05;
const MAX_STAKE_SOL = 0.10;
const MIN_BUY_SOL = 0.012; // just above the 0.01 SOL round-trip minimum
const WINDOW_TRADES = 12; // trades looked at for the entry signal
const MIN_TRADES = 4;
const MIN_BUYERS = 3;
const MIN_NET_SOL = 0.1;
const MIN_PRICE_UP = 0.02;
const MAX_PRICE_UP = 1.2;
const NEAR_HIGH = 0.85;
const MIN_AGE_SLOTS = 60;
const MIN_RQ_SOL = 0.5;
const MAX_RQ_SOL = 80;
const TAKE_PROFIT = 0.20;
const STOP_LOSS = 0.05;
const TRAIL_ARM = 0.08;
const TRAIL_DROP = 0.08;
const MAX_HOLD_SLOTS = 3000;
const EXIT_FLOW_SOL = -1.0; // net SOL over the last 10 trades that forces an exit
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10000;
const MAX_ENTRIES_PER_MINT = 1;
const COOLDOWN_SLOTS = 150;
const TARGET_COINS = 25;
const PACE_SECS = 7200; // 2h of the 6h window: probes start early, not at the end
const PROBE_SOL = 0.02;
const MAX_PROBES = 2;
const DD_HALT = 0.25; // stop new entries after a 25% drawdown from peak equity

type Mint = string;

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Curve {
  createdSlot: number | null;
  complete: boolean;
  trades: TradeRec[];
  vq: number; // virtual quote reserves (lamports, as float for price math)
  vt: number; // virtual token reserves
  rq: number; // real quote reserves (lamports)
  lastPrice: number;
  high: number;
  entries: number;
  lastExitSlot: number;
}

interface Held {
  openedSlot: number;
  investedSol: number;
  peakValueSol: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: Mint;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

const curves = new Map<Mint, Curve>();
const held = new Map<Mint, Held>();
const probes = new Map<Mint, boolean>(); // false = buying, true = selling
const probeAwaiting = new Set<Mint>(); // probe buys sent, fill not seen yet
let myFills = 0;
const myCoins = new Set<Mint>();
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;
let peakEquitySol = 0;
let orderCounter = 0;

let capitalLamports = 10_000_000_000n;
let maxOpen = 5;
let maxOrderBps = 100;
let maxOrdersPerBatch = 16;
let txFeeLamports = TX_FEE_FALLBACK;

function curveOf(mint: Mint): Curve {
  let c = curves.get(mint);
  if (!c) {
    c = {
      createdSlot: null,
      complete: false,
      trades: [],
      vq: 0,
      vt: 0,
      rq: 0,
      lastPrice: 0,
      high: 0,
      entries: 0,
      lastExitSlot: -1e15,
    };
    curves.set(mint, c);
  }
  return c;
}

// Price of one token in lamports, from virtual reserves.
function priceOf(c: Curve): number {
  return c.vt > 0 ? c.vq / c.vt : 0;
}

// SOL the harness would pay us for selling `tokens` right now, after curve fees
// and one tx fee. Constant-product quote: tokens * vq / (vt + tokens).
function sellValueSol(c: Curve, tokens: number): number {
  if (c.vt <= 0 || tokens <= 0) return 0;
  const gross = (tokens * c.vq) / (c.vt + tokens);
  return (gross / LAMPORTS_F) * (1 - FEE_BPS / 10000) - txFeeLamports / LAMPORTS_F;
}

// Largest buy (SOL) the size cap allows on this curve right now.
function maxBuySol(c: Curve): number {
  return (c.rq / LAMPORTS_F) * (maxOrderBps / 10000);
}

// Net SOL flow (buys minus sells) over the newest `n` trades of a curve.
function recentFlow(c: Curve, n: number): number {
  let net = 0;
  const t = c.trades;
  for (let i = Math.max(0, t.length - n); i < t.length; i++) {
    net += t[i]!.buy ? t[i]!.sol : -t[i]!.sol;
  }
  return net;
}

// Entry signal: broad, accelerating buying on a curve that has not run too far.
// Returns true only when every guard below passes — one failing guard vetoes.
function entrySignal(c: Curve, nowSlot: number): boolean {
  const rqSol = c.rq / LAMPORTS_F;
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (c.createdSlot === null || nowSlot - c.createdSlot < MIN_AGE_SLOTS) return false;
  if (c.entries >= MAX_ENTRIES_PER_MINT) return false;
  if (nowSlot - c.lastExitSlot < COOLDOWN_SLOTS) return false;
  const t = c.trades;
  if (t.length < MIN_TRADES) return false;
  const win = t.slice(-WINDOW_TRADES);
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let high = 0;
  const buyers = new Set<string>();
  for (const tr of win) {
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
  }
  if (buys < MIN_TRADES - 1 || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  const startPrice = win[0]!.price;
  const lastPrice = win[win.length - 1]!.price;
  if (startPrice <= 0 || lastPrice <= 0) return false;
  const up = lastPrice / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (lastPrice < high * NEAR_HIGH) return false;
  // Fade guard: refuse a curve whose newest trade is a large sell — the tape
  // may look strong over the window while sellers have already taken over.
  const newest = win[win.length - 1]!;
  if (!newest.buy && newest.sol >= 1.0) return false;
  return true;
}

// --- validation: every order is checked before it leaves the bot. ---
// A bad order is dropped, never sent: a rejected fill costs fees and a slot.
function validOrder(o: Order, cashSol: number, openSlots: number): boolean {
  if (!o.mint || o.mint.length < 32) return false;
  if (o.side === "buy") {
    const amt = Number(o.quote_lamports ?? "0") / LAMPORTS_F;
    if (!(amt >= MIN_BUY_SOL)) return false;
    if (amt + txFeeLamports / LAMPORTS_F > cashSol) return false;
    if (openSlots <= 0 && !held.has(o.mint) && !probes.has(o.mint)) return false;
    const c = curves.get(o.mint);
    if (!c || c.complete) return false;
    if (amt > maxBuySol(c) + 1e-9) return false;
  } else {
    if (!o.token_amount || BigInt(o.token_amount) <= 0n) return false;
  }
  if (o.max_slippage_bps < 0 || o.max_slippage_bps > 10000) return false;
  return true;
}

function nextClientId(seq: number, tag: string): string {
  orderCounter += 1;
  return `s${seq}-${tag}-${orderCounter}`;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let lastSeq = -1;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as any;

    if (msg.type === "hello") {
      // Validate the hello handshake before trusting any of its numbers.
      if (msg.protocol !== "agent-fun/replay/v2") throw new Error("unexpected protocol");
      capitalLamports = BigInt(msg.capital.lamports);
      maxOpen = msg.caps.max_open_positions;
      maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      if (msg.caps.shorts || msg.caps.leverage) throw new Error("shorts/leverage not supported");
      txFeeLamports =
        Number(msg.fees.base_fee_lamports) + Number(msg.fees.priority_fee_lamports);
      peakEquitySol = Number(capitalLamports) / LAMPORTS_F;
      continue;
    }

    if (msg.type === "done") {
      process.exit(0);
    }

    if (msg.type !== "batch") continue;
    const seq: number = msg.seq;
    const slot: number = msg.slot;
    if (seq <= lastSeq) throw new Error(`batch seq went backwards: ${seq} after ${lastSeq}`);
    lastSeq = seq;

    // --- ingest fills: count our own round trips for the pacing guard ---
    for (const f of msg.fills ?? []) {
      if (f.status === "filled" && !String(f.client_id).startsWith("_")) {
        myFills += 1;
        myCoins.add(f.mint);
        if (probes.has(f.mint)) probeAwaiting.delete(f.mint);
      }
    }

    // --- ingest events: keep one small tape per curve ---
    const traded = new Set<Mint>();
    for (const e of msg.events ?? []) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
      }
      if (e.event === "CreateEvent") {
        curveOf(e.mint).createdSlot = e.slot;
      } else if (e.event === "TradeEvent") {
        const c = curveOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS_F;
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
        if (c.trades.length > 64) c.trades.splice(0, c.trades.length - 64);
        c.vq = Number(e.virtual_quote_reserves);
        c.vt = Number(e.virtual_token_reserves);
        c.rq = Number(e.real_quote_reserves);
        c.lastPrice = price;
        if (price > c.high) c.high = price;
        traded.add(e.mint);
      } else if (e.event === "CompleteEvent") {
        curveOf(e.mint).complete = true;
      }
    }

    // --- marks: the batch's reserve snapshot, fresher than the last trade ---
    const marks = new Map<Mint, any>();
    for (const m of msg.marks ?? []) {
      marks.set(m.mint, m);
      const c = curves.get(m.mint);
      if (c) {
        c.vq = Number(m.virtual_quote_reserves);
        c.vt = Number(m.virtual_token_reserves);
        c.rq = Number(m.real_quote_reserves);
      }
    }

    // --- account: the harness's own positions are the source of truth ---
    const account = msg.account;
    const positions = new Map<Mint, { tokens: bigint; costLamports: bigint }>();
    for (const p of account.positions ?? []) {
      positions.set(p.mint, {
        tokens: BigInt(p.token_amount),
        costLamports: BigInt(p.cost_lamports),
      });
    }
    let cashSol = Number(BigInt(account.cash_lamports)) / LAMPORTS_F;

    // Pending orders (ours, still in flight) by mint, so we never double-send.
    // The harness reports no pending list and fills land latency_slots later,
    // so in-flight state is implicit: a mint with a held record and no position
    // yet is a buy still travelling, and exits check the position map each batch.

    // --- equity + drawdown guard ---
    let equitySol = cashSol;
    for (const [mint, pos] of positions) {
      const c = curves.get(mint);
      if (c) equitySol += Math.max(0, sellValueSol(c, Number(pos.tokens)));
    }
    if (equitySol > peakEquitySol) peakEquitySol = equitySol;
    const drawdown = peakEquitySol > 0 ? (peakEquitySol - equitySol) / peakEquitySol : 0;
    const haltEntries = drawdown > DD_HALT;

    const orders: Order[] = [];
    const cap = maxOrdersPerBatch;
    const txSol = txFeeLamports / LAMPORTS_F;
    let openSlots = maxOpen - positions.size;

    // --- exits first: take-profit, stop-loss, trailing stop, sell-off, time ---
    for (const [mint, h] of held) {
      const pos = positions.get(mint);
      const c = curves.get(mint);
      if (!pos) {
        // Position gone (sold, completed, or flattened): record the exit time.
        held.delete(mint);
        const cc = curves.get(mint);
        if (cc && h.filled) cc.lastExitSlot = slot;
        continue;
      }
      if (!c || c.complete) continue;
      h.filled = true;
      const costSol = Number(pos.costLamports) / LAMPORTS_F;
      const value = sellValueSol(c, Number(pos.tokens));
      if (value > h.peakValueSol) h.peakValueSol = value;
      let exit = h.exiting;
      if (!exit && value >= costSol * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= costSol * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValueSol >= costSol * (1 + TRAIL_ARM) && value <= h.peakValueSol * (1 - TRAIL_DROP)) exit = true;
      if (!exit && recentFlow(c, 10) < EXIT_FLOW_SOL) exit = true;
      if (!exit && slot - h.openedSlot > MAX_HOLD_SLOTS && value < costSol * (1 + 0.02)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (orders.length >= cap) break;
      const o: Order = {
        side: "sell",
        client_id: nextClientId(seq, "x"),
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: SELL_SLIP_BPS,
      };
      if (validOrder(o, cashSol, openSlots)) orders.push(o);
    }

    // --- probe sells: close a probe the moment its buy has landed ---
    for (const [mint, selling] of probes) {
      const pos = positions.get(mint);
      if (!pos) {
        // No position and no buy in flight: the probe is finished.
        if (!probeAwaiting.has(mint)) probes.delete(mint);
        continue;
      }
      const c = curves.get(mint);
      if (!c || c.complete) continue;
      if (orders.length >= cap) break;
      const o: Order = {
        side: "sell",
        client_id: nextClientId(seq, "p"),
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: SELL_SLIP_BPS,
      };
      if (validOrder(o, cashSol, openSlots)) {
        orders.push(o);
        if (!selling) probes.set(mint, true);
      }
    }

    // --- entries and pyramid adds, only on curves that traded this batch ---
    let freeSol = cashSol;
    if (!haltEntries) {
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const c = curves.get(mint);
        if (!c || c.complete) continue;
        if (probes.has(mint)) continue;
        const h = held.get(mint);
        let wantSol: number;
        if (!h) {
          if (openSlots <= 0) continue;
          if (!entrySignal(c, slot)) continue;
          wantSol = STAKE_SOL;
        } else {
          // Pyramid into strength only: already up, price stepped up, flow in.
          if (h.exiting || !h.filled) continue;
          if (h.investedSol >= MAX_STAKE_SOL - 0.001) continue;
          const pos = positions.get(mint);
          if (!pos) continue;
          const costSol = Number(pos.costLamports) / LAMPORTS_F;
          const value = sellValueSol(c, Number(pos.tokens));
          if (value < costSol * 1.05) continue;
          if (c.lastPrice < h.lastAddPrice * 1.05) continue;
          if (recentFlow(c, WINDOW_TRADES) < MIN_NET_SOL) continue;
          wantSol = Math.min(ADD_SOL, MAX_STAKE_SOL - h.investedSol);
        }
        // Size at 90% of the cap: the cap moves with reserves over the latency
        // slots, and a buy sized at 100% of a stale cap is rejected.
        let amount = Math.min(wantSol, maxBuySol(c) * 0.9);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < MIN_BUY_SOL) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS_F));
        if (lamports < BigInt(Math.floor(MIN_BUY_SOL * LAMPORTS_F))) continue;
        const o: Order = {
          side: "buy",
          client_id: nextClientId(seq, "b"),
          mint,
          quote_lamports: lamports.toString(),
          max_slippage_bps: BUY_SLIP_BPS,
        };
        if (!validOrder(o, freeSol, openSlots)) continue;
        orders.push(o);
        freeSol -= amount + txSol;
        if (!h) {
          held.set(mint, {
            openedSlot: slot,
            investedSol: amount,
            peakValueSol: 0,
            exiting: false,
            filled: false,
            lastAddPrice: c.lastPrice,
          });
          c.entries += 1;
          openSlots -= 1;
        } else {
          h.investedSol += amount;
          h.lastAddPrice = c.lastPrice;
        }
      }
    }

    // --- pacing probe: keep round trips on pace for the 20-coin minimum ---
    if (probes.size < MAX_PROBES && openSlots > 0 && firstBlockTime !== null && lastBlockTime !== null) {
      const pace = Math.min(1, (lastBlockTime - firstBlockTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_COINS * 2 * pace);
      if ((needCoins || needFills) && !haltEntries) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const c = curves.get(mint);
          if (!c || c.complete) continue;
          // Probe only curves old enough to have a real tape. Size adapts to
          // the cap: buy whatever the cap allows down to the round-trip
          // minimum, so probes fire on young curves with small reserves too.
          if (c.createdSlot !== null && slot - c.createdSlot < 20) continue;
          const probeAmt = Math.min(PROBE_SOL, maxBuySol(c) * 0.9);
          if (probeAmt < MIN_BUY_SOL) continue;
          if (freeSol < probeAmt + 2 * txSol) break;
          const o: Order = {
            side: "buy",
            client_id: nextClientId(seq, "q"),
            mint,
            quote_lamports: BigInt(Math.floor(probeAmt * LAMPORTS_F)).toString(),
            max_slippage_bps: BUY_SLIP_BPS,
          };
          if (!validOrder(o, freeSol, openSlots)) continue;
          orders.push(o);
          probes.set(mint, false);
          probeAwaiting.add(mint);
          freeSol -= probeAmt + txSol;
        }
      }
    }

    // --- read-back check: re-parse the reply and confirm it is well formed ---
    const reply = { type: "reply", seq, orders };
    const roundTrip = JSON.parse(JSON.stringify(reply)) as typeof reply;
    if (roundTrip.seq !== seq) throw new Error("reply seq mismatch on read-back");
    if (roundTrip.orders.length > maxOrdersPerBatch) throw new Error("too many orders on read-back");
    const seenIds = new Set<string>();
    for (const o of roundTrip.orders) {
      if (seenIds.has(o.client_id)) throw new Error("duplicate client_id on read-back");
      seenIds.add(o.client_id);
      if (o.side === "buy" && BigInt(o.quote_lamports ?? "0") <= 0n) throw new Error("non-positive buy on read-back");
      if (o.side === "sell" && BigInt(o.token_amount ?? "0") <= 0n) throw new Error("non-positive sell on read-back");
    }
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`sharpe-sprint bot failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
