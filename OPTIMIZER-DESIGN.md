# Auto Trade Routes v2 — Optimizer Overhaul Design

*Sources: live game UI (Reign of Fire x2 Europe, inspected 2026-07-18), official Travian support docs, community references, and the current codebase.*

## Progress
- [x] Research + Part I design (problem model, algorithm, modes)
- [x] Part II pre-implementation spec (P0–P9)
- [x] **S1 — Foundations**: torus `dist()`, `tauH()` + `tauCache` learned travel times, puller v1.11.0 (`travelSec`/`kind`/`ships`), ship-route carrier ledger — commit `178912f`
- [x] **S2 — Flow core**: Model build, tiers T0–T4, SSP min-cost flow, tier-class materialization + re-injection, `v1 | v2` engine toggle (v1 default)
- [x] **S3 — Simulator**: 48h discrete-event sim (A1 partial sends, carrier round trips) + repair loop (interval↓/trim/restagger) + A/B v1-vs-v2 line, sim verdict in the plan summary
- [x] **S4 — Modes & diff-apply**: diff-apply changeset ✓ (`f7c753d`) · direct/hub/centralize/auto arc policies + Auto lexicographic compare ✓ (`117570b`) · **v2 is now the default engine** (one-time profile migration; v1 kept as "legacy" fallback)
- [x] **S5 — Polish**: dead-code removal ✓ (`24c7701`) · arrival-aware staggering ✓ (`c5a127c`, sim-validated, guarded) · NPC-merchant hint ✓ (`d134576`) · burst-fill hint ✓ (exact sim deficit, gated by optMinRoute)
- Extra user features: "Excess crop → Capital" sink in any policy (`0bfbc47`) · actionable "not enough carrier capacity → upgrade Trade Office" warning (`0bfbc47`) · merged the in-game route-apply feature (`65f8400`)

**v2 is complete and shipped as the default optimizer engine.** All S1–S5 stages done; every plan is validated by the 48h simulator with repair, and the A/B line still runs v1 on the same state for comparison.

---

## 1. Verified game model (constraints & parameters)

### Trade routes (from the live creation dialog + synced route JSON)
| Fact | Value | Source |
|---|---|---|
| Repeat interval | **{1, 2, 3, 4, 6, 8, 12, 24} h or "send once"** (`repeatEvery`) | live dialog `select[name=repeatEvery]` |
| Scheduling anchor | departure time **or** arrival time | official docs |
| Deliveries | route can run "n×" back-to-back deliveries per firing | official docs ("3×1" = 3 deliveries × 1 merchant) |
| Carrier kind | **merchants XOR trade ships** per route (`useTradeShips` flag; `merchants` and `ships` fields) | synced route JSON schema |
| Route JSON schema | `{id, enabled, sendOnce, carriedResources, departureAt, arrivalAt, repeat, merchants, ships, useTradeShips}` | live page |
| **Real travel time** | `arrivalAt − departureAt` per existing route send | live page — **goldmine, see §4 Phase 0** |
| Targets | own villages, WW, alliance artifact villages | official docs |
| Requires | Gold Club | official docs |

### Carriers
| Fact | Value |
|---|---|
| Merchants per village | marketplace level (1/level); **per-village tribe** (this account has GAL/ROM/EGY/TEU/SPR/HUN villages — stats differ per village!) |
| Merchant base capacity (x1) | Romans 500 · Teutons 1000 · Gauls 750 · (Egyptians 750, Huns 500, Spartans 500) — ×2 on this x2 server |
| Trade office | +10%/level capacity (Romans +20%/level) |
| Alliance commerce bonus | boosts capacity **and** speed; % varies and is toggled by leadership → treat as user-set/ignorable (already modeled) |
| Trade ships | harbor villages only; up to 210 total at harbor 20; **do not consume merchants**; ~20 f/h over water (x1), tribe merchant speed over land → **Euclidean × speed is wrong for ships**; real per-village capacity already synced (`shipCapacityReal`) |
| Carrier reuse | a carrier is busy for the full round trip 2·τ; a route firing every I h keeps `waves = ceil(2τ/I)` carrier-sets committed |
| Real capacities | puller already captures `merchantCapacityReal` / `shipCapacityReal` (bakes in TO + bonus at sync time) |

### World
- Map is a **401×401 torus** — shortest Δ per axis: `dx = min(|Δx|, 401−|Δx|)`. The current `dist()` does not wrap (bug for far pairs).
- Storage: warehouse (L/C/I) and granary (crop) caps; overflow = production lost; empty granary = starvation.

### Assumption to verify in-game (A1)
When a route fires with insufficient resources/merchants: observed behavior on this server is a partial send (game sends what's there). Not officially documented. The simulator (§4 Phase 4) models it pessimistically as *partial for resources, skipped if no carrier free*; a one-time in-game test can pin it down.

---

## 2. Formal problem statement (academic)

**Sets.** Villages `V` (n≈20); resources `K = {lumber, clay, iron, crop}`; carrier kinds `F = {merchant, ship}`; allowed intervals `I = {1,2,3,4,6,8,12,24}`.

**Data.** Sustainable base production `p[v,k]` (boosts/hero stripped per settings); crop upkeep `u[v]`; storage caps `C[v,k]`, stocks `s[v,k]`; requirement tiers `r_t[v,k]` (training burn, custom needs, celebration, build buffer) with priority order; carrier counts `m[v,f]`, capacities `q[v,f]`; travel time `τ[u,v,f]`.

**Decision variables.** For each ordered pair and kind: flow rates `x[u,v,f,k] ≥ 0`; integer carriers `y[u,v,f] ∈ ℤ₊`; interval `i[u,v,f] ∈ I`; route-open indicator `z[u,v,f] ∈ {0,1}`.

**Constraints.**
1. *Node balance / no phantom sourcing*: out-flow of `k` at `v` ≤ base surplus + in-flow (relays conserve; iterated to fixpoint).
2. *Carrier budget*: `Σ_routes from v of kind f: ceil(2τ/i) · ceil(perSend/q) ≤ m[v,f]`.
3. *Kind exclusivity*: a route carries one kind (`x > 0 ⇒` single `f`).
4. *Fixed charge / min route*: `Σ_k x[u,v,f,k] ≥ minH · z[u,v,f]`.
5. *Storage safety*: net inflow rate at `v` keeps `s + net·t ∈ [0, C]` over the horizon (no overflow within H hours; no starvation ever).
6. *Interval discreteness*: `i ∈ I`, per-send `= x·i` integral.
7. *Mode topology*: arc set restricted by mode (see §5).

**Objective — lexicographic (preemptive goal programming):**
- **T0** maximize coverage of crop starvation (weighted by time-to-empty),
- **T1** maximize requirement coverage in supply-priority order,
- **T2** maximize overflow-loss avoided,
- then minimize carrier-hours used, then number of routes.

**Classification.** This is a **periodic, multi-commodity, capacitated transshipment problem with fixed charges and integer vehicle constraints** — a service-network-design / **inventory-routing (IRP)** family member. It contains fixed-charge network flow ⇒ **NP-hard**. With intervals/kinds relaxed it collapses to **min-cost multi-commodity flow** (polynomial, LP). Because L/C/I and crop rarely compete for the same *arcs* (only for carriers), we decompose by resource-tier and treat carrier capacity as the coupling resource — the classic **Lagrangian/sequential decomposition** for IRP. Exact solution would be a small **MILP** (branch-and-bound); at n≤25 a heuristic pipeline with simulation-validation is faster, explainable, and near-optimal.

---

## 3. Why the current optimizer falls short (motivation)

| Current behavior | Problem |
|---|---|
| Greedy per-receiver scan, receivers sorted by ETA | order-dependent; an early receiver can grab a far donor while a later one starves; no global view |
| Euclidean distance × constant speed | wrong for ships (water paths) and for far pairs (no torus wrap) |
| Min-route filter *drops* small merged routes | the dropped flow silently disappears — coverage lost without re-planning |
| No end-state validation | phantom-coverage-class bugs possible (one already fixed by hand) |
| Apply = replace all auto routes | churns in-game routes even when 1 route changed |
| Crop plan → troop plan → overflow → sweep, each greedy on leftovers | sequential ordering ≠ global optimum; tiers exist implicitly but aren't enforced end-to-end |
| Offsets staggered `i/n` naively | ignores arrival clustering and carrier concurrency |

---

## 4. Proposed algorithm — five-phase pipeline (words first)

> **In one sentence:** build an accurate flow network, solve a tiered min-cost flow for *what should move where*, then turn flows into legal periodic routes, then *simulate 48h* to prove the plan works, repairing what fails.

### Phase 0 — Model build ("get the physics right")
- Sustainable rates per village: base production − upkeep − reserves, requirements by tier.
- **Travel-time matrix `τ`**: for pairs with an existing/synced route, *learn* `τ = arrivalAt − departureAt` (exact, includes water paths). Otherwise estimate: torus distance / effective speed per kind. Keep a persistent `τ` cache; every sync refines it.
- Carrier inventory per village per kind, minus carriers committed to non-auto (manual) routes.

### Phase 1 — Demand tiers (lexicographic)
- **T0 starvation:** crop deficits (net < 0), urgency-weighted by granary time-to-empty.
- **T1 requirements:** troop-training L/C/I burn + custom needs, in the user's supply-priority order.
- **T2 reserves:** celebration & build buffers.
- **T3 overflow relief:** villages whose warehouse fills within the horizon.
- **T4 stockpile:** mode sink (e.g. centralize leftover crop at capital) — lowest priority.

### Phase 2 — Tiered min-cost flow ("what moves where")
For each tier in order, solve a **min-cost flow** on the residual network (capacities reduced by higher tiers' allocations):
- Arc cost = **carrier-time per unit** `τ/q` (naturally prefers ships and near donors) + ε-penalties: capital donation, relay hops, new-route fixed-charge proxy.
- Transshipment nodes: hubs allowed to relay (conservation enforced — what a hub forwards it must receive or produce).
- Algorithm: **successive shortest augmenting paths with node potentials** (Dijkstra); at n≤25 villages/O(600) arcs this is sub-millisecond. (Equivalently network simplex; SSP is simpler in JS.)
- Output: fractional flow rates per (pair, kind, resource).

### Phase 3 — Materialization ("make it a legal Travian route")
- Group flows by (pair, kind) → one multi-resource route.
- **Interval choice:** largest `i ∈ {1..24}` satisfying: receiver never dips empty between arrivals, one batch fits receiver free space, batch ≤ sensible per-send; round *down* on safety deadlines.
- **Carrier packing:** per-send = rate×i; carriers = `ceil(perSend/q) × ceil(2τ/i)` (waves); pack across the donor's fleets First-Fit-Decreasing; if short, shrink this route and **re-inject the residual flow into Phase 2's residual graph and re-solve** — nothing silently lost (fixes the min-route drop bug the same way: filtered flow is re-routed through bigger arcs when possible).
- **Offset staggering:** spread departures so (a) a donor's carriers aren't simultaneous, (b) arrivals at a receiver are evenly spaced across the interval (smooth stock curve → smaller safety buffers needed).

### Phase 4 — Simulation validation & repair ("prove it")
Discrete-event **simulation of 48h**: production ticks, route firings (with A1 partial-send rule), arrivals, storage clamps.
- Check: no village starves, no requirement under-served beyond tolerance, no overflow beyond horizon, no carrier over-commitment at any instant.
- On violation → targeted repair (shorten interval / add a wave / reroute via flow re-solve) → re-simulate (≤3 loops).
- This is the structural safety net: an entire class of bugs (phantom coverage, over-provisioned routes, wave miscounts) turns into *visible sim failures* instead of silent bad plans.

### Phase 5 — Presentation & minimal diff
- Per-village ledger: production / in / out / net per resource, tier tags, and the two diagnostics already built (carrier-limited ▲ vs demand-limited).
- Plan compare: show lexicographic score vector per mode (see §5) when Auto mode picks.
- **Apply as diff:** compare proposed vs existing auto routes → emit add/edit/delete changeset (stable route identity = pair+kind), instead of wiping all auto routes.

---

## 5. Modes = arc-set policies (same engine, different graphs)

| Mode | Arc policy |
|---|---|
| **Direct balance** | complete digraph; hubs optional transshipment |
| **Hub distribute** | crop arcs: donor→hub, hub→receiver only (star); L/C/I unrestricted |
| **Capital centralize** (current new mode) | crop: village→capital→hub→receivers two-tier; T4 sink at capital |
| **Auto** | solve all applicable modes, compare lexicographic objective vectors `(T0, T1, T2, T3, carrierHours)`, present winner + comparison table |

Capital-sends-last, troop-villages-never-donate-crop, single-carrier-kind, min-route-total — all preserved as costs/constraints, not special-case code paths.

---

## 6. Complexity & footprint
- Phase 2: O(tiers × paths × Dijkstra) ≈ sub-ms at this scale. Phase 4 sim: ~10⁴ events, <10ms. Whole pipeline well under 100ms in the sandboxed dashboard — no worker needed, no dependencies.
- Optional future flag: exact MILP via a bundled WASM solver for ≤15 villages ("exact mode") to benchmark the heuristic; not needed for v1.

## 7. Staged implementation plan (when approved)
1. **S1 foundations:** torus distance, τ-matrix learn/cache from synced `arrivalAt−departureAt`, carrier ledger refactor. (Everything else keeps working.)
2. **S2 flow core:** tiered SSP min-cost flow + materialization behind a `optimizer v2` toggle; old path untouched.
3. **S3 simulator:** 48h sim + repair loop; run it on *both* old and new plans to A/B trust.
4. **S4 modes & diff-apply**, switch default to v2, retire dead code (`applyPlan`/`applyAll` already dead).
5. **S5 polish:** arrival-aware staggering, deliveries "n×" burst support (initial stock fill), NPC-merchant hint at hub.

## 8. Open items to verify
- **A1** partial vs skipped send on insufficient resources (one in-game observation settles it).
- Ship τ for pairs with no route history (first estimate via water-speed heuristic; refine after first real send).
- Alliance commerce % on this server (Ignore-bonuses toggle already covers it).
- Whether "deliveries n×" is worth using (burst-fill a starving granary faster than interval alone).

---
---

# Part II — Pre-implementation specification

*Everything below is spec, precise enough that implementation is mechanical. No code has been written.*

## P0. Phase 0 — Model build

### P0.1 Data structures
```js
// Built once per run from state.* — pure, no DOM.
Model = {
  vils: [{
    id, name, x, y,
    flags: {capital, cropHub, troop, building, supplyTarget /* hasSupplyNeed */},
    priority,                       // troopPriority (shared order)
    stock:   {lumber, clay, iron, crop},          // current, projected to now
    cap:     {lumber, clay, iron, crop},          // warehouse×3 + granary
    prod:    {lumber, clay, iron, crop},          // prodBase() per k
    upkeep,                                        // consumption(v) (crop only)
    needs:   {lumber, clay, iron, crop},          // troopNeedsPerHour(v) (training + custom)
    reserve: {lumber, clay, iron, crop},          // celebration + build buffer (keepReserve)
    fleets: [{kind:'merchant'|'ship', free, cap}] // counts minus manual-route commitments
  }],
  tau: (fromId, toId, kind) => seconds,           // §P0.2
  mode, settings: {minRoute, overflowH, fillH, troopCropExtra, cropToCapital, ...}
}
```

### P0.2 Travel-time matrix τ (learn > estimate)
- **Persistent cache** `state.tauCache = { "fromDid>toDid>kind": {sec, src:'learned'|'est', at} }`.
- **Puller change (only puller change in v2):** `extractTradeRoutes` additionally emits per destination
  `travelSec = median(arrivalAt − departureAt)` and `kind = useTradeShips ? 'ship' : 'merchant'`
  (fields confirmed present in the live JSON). `mergeSyncRoutes` upserts `tauCache` entries with `src:'learned'`.
- **Estimate fallback** (no history): `sec = 3600 · distTorus(u,v) / speed(kind, u)`, ships × path factor
  `λ_water = 1.15` (tunable constant; corrected automatically once a real send is observed).
- **Torus distance** (replaces `dist()` everywhere):
  `dx = min(|Δx|, 401−|Δx|); dy = min(|Δy|, 401−|Δy|); distTorus = max(1, √(dx²+dy²))`.

### P0.3 Design change vs v1: reserves become demands
v1 pre-subtracts `keepReserve` from every donor. v2 makes celebration/build buffers **T2 demands** instead —
so a *starving* village (T0) can tap a donor's celebration buffer, but a mere stockpile (T4) cannot.
Strictly better prioritization, zero extra mechanism.

## P1. Phase 1 — Tier definitions (exact)

Let `surplus[v][k] = prod − (k=crop ? upkeep : 0) − alreadyAllocated`. Demands are *rates* (/h).

| Tier | Demand at v | Amount | Weight/order |
|---|---|---|---|
| **T0** starvation | crop, if `netCrop<0` | `−netCrop · (troop ? 1+extra% : 1)` | urgency `1/etaEmpty`, nearest-empty first |
| **T1** requirements | L/C/I where `needs>prod` | `needs[k] − prod[k] − inflow` | strict user priority order (sequential solves per village) |
| **T2** reserves | own celebration+build buffer not covered by own prod | `max(0, reserve[k] − ownSurplus[k])` | any order (small) |
| **T3** overflow relief | at villages WITH room: rate they can absorb `(cap−stock)/fillH` | export obligation at filling villages: `max(0, surplus − (cap−stock)/overflowH)` | most-urgent source first |
| **T4** stockpile | mode sink (centralize: crop at capital) | `min(donor leftovers, capRoom/horizon)` | last, leftover carriers only |

Self-supply is implicit: demands are net of own production before any arc is used.

## P2. Phase 2 — Flow solve (per tier, per resource)

**Decomposition decision:** solve **single-commodity** min-cost flow per (tier, resource) in lexicographic
order; the only cross-resource coupling is carriers, reconciled in Phase 3's re-injection loop and certified
in Phase 4. This trades a provably-optimal multi-commodity MILP for a simple, explainable pipeline — the sim
is the guarantee.

### P2.1 Graph construction (per solve)
- Node per village; hubs split into `in/out` halves (internal arc = throughput bound) when the mode restricts relaying.
- Source-side capacity at u: remaining `surplus[u][k]` (after higher tiers).
- Arc (u→v, kind f) exists iff the mode's arc policy allows it (§5) and `u.fleets[f].free > 0`.
- **Arc capacity** = `min(surplus_u, (free_f · cap_f) / (2·τ(u,v,f)/3600))` — max sustainable rate on that fleet.
- **Arc cost** (integer, ×1000): `τ(u,v,f)/cap_f` (carrier-seconds per unit)
  `+ 10% if u.capital (capital-sends-last as price, not ban)`
  `+ ε per hub hop (prefer direct when equal)`.

### P2.2 Algorithm
Successive Shortest Augmenting Path with node potentials (all costs ≥ 0 ⇒ plain Dijkstra on reduced costs):
```
while (unmet demand) and (augmenting path exists):
  find min-cost path source-set → demand-node (Dijkstra, reduced costs)
  augment by min(residual capacities, remaining demand)
  update potentials π[v] += dist[v]
Output: flow rates x[u→v, f] for this (tier, k)
```
n≤25, arcs ≤ ~1200 ⇒ sub-millisecond per solve, ~40 solves total.

## P3. Phase 3 — Materialization

### P3.1 Route assembly
Group flows by `(u, v, f)` across tiers & resources → one multi-resource route candidate with
`rate[k]` and `tierTags`.

### P3.2 Interval selection (per route)
```
I_max_room   = freeSpace_recv / totalRate          // one batch must fit
I_max_bridge = (stock_recv + inflightMargin) / max(1, drainGap_recv)   // receiver never empties between arrivals
I_eff        = clamp(2τ/3600 rounded to allowed, 1, 24)                 // waves ≤ ~2 for carrier efficiency
I = snapFloor( min(24, I_max_room, I_max_bridge, max(1, I_eff)) )       // ∈ {1,2,3,4,6,8,12,24}
```

### P3.3 Carrier packing (per donor, FFD)
```
perSend[k] = round(rate[k] · I);  total = Σ perSend
carriersNeeded = ceil(total / cap_f) · ceil((2τ/3600) / I)      // sets × waves
FFD across donor's fleets of that kind; if free < needed:
   scale route down to what fits; RESIDUAL rate goes back to the pool  → §P3.5
```

### P3.4 Min-route filter with re-injection (fixes v1's silent drop)
Route total rate < `minRoute` ⇒ remove route, mark that arc penalized (+50% cost), return its
demand to the residual pool.

### P3.5 Re-injection loop
```
repeat ≤ 3 times while residual pool non-empty:
   rebuild residual graph (saturated fleets removed, penalties applied)
   re-run Phase 2 on residual demands; materialize additions
leftover residual → unmet report with reason ∈ {carrier-limited, demand-limited, below-min-route, no-path}
```

### P3.6 Offset staggering (arrival-aware)
Greedy over a 24h × 0.5h-slot timeline per donor: place each route's departure in the slot minimizing
(1) the donor's peak concurrent carriers, then (2) variance of arrival spacing at the receiver.
Deterministic (stable sort by route key).

## P4. Phase 4 — Simulation & repair

### P4.1 Simulator (discrete-event, 48h)
- Events: route departure (offset + n·I), arrival (departure + τ). Between events, integrate
  `stock += (prod − upkeep − trainingBurn)·Δt`, clamp `[0, cap]`, log overflow loss.
- Departure rule (**A1**, pessimistic): send `min(perSend, availableStock)` per resource (partial);
  **skip** entirely if the donor's free carriers at that instant < carriersPerSend; log skips.
- Track in-flight carriers per village per kind at every event (exact, not amortized).

### P4.2 Checks → repairs (≤ 3 repair passes, then finalize with warnings)
| Violation | Repair (in order) |
|---|---|
| crop stock hits 0 at a receiver | shorten that route's I to next allowed ↓ → add a wave → re-flow tier T0 residual |
| requirement coverage < 98% over horizon | same ladder on the serving route |
| overflow loss > tolerance at receiver | lengthen I ↑ → reduce perSend → drop lowest-tier inflow route |
| carrier over-commitment instant | re-stagger offsets → drop lowest-tier route from that donor |

The sim is the structural guard: phantom coverage, wave miscounts, and over-provisioned in-game
routes all surface as concrete failed checks *before* the user sees the plan.

## P5. Phase 5 — Presentation & apply

- **Ledger** per village: prod / in / out / net per resource, tier badges, diagnosis chip
  (`ok · carrier-limited ▲ · demand-limited · unmet`), sim sparkline data (min/max stock over 48h).
- **Auto mode comparison:** rows = modes, cols = `(T0%, T1%, overflow loss, carrier-hours, #routes)`;
  lexicographic winner applied, table shown.
- **Diff apply** (replaces wipe-and-replace): route identity = `from>to>kind`.
  `add` (new key) · `update` (resources/interval/offset drift beyond 5%) · `delete` (auto route no longer planned).
  Manual/synced routes untouched. UI lists the changeset before saving.
- Engine toggle in Auto-Routes controls: `v1 (legacy) | v2` — v1 code path untouched until v2 is trusted.

## P6. Constants (single table, all tunable)
| Const | Value | Meaning |
|---|---|---|
| `OVERFILL_HORIZON` | 12h | keep: receiver may not fill faster than this (non-troop) |
| `WAREHOUSE_FILL_H` | 8h | keep: troop-village fill rate / urgency threshold |
| `λ_water` | 1.15 | ship τ estimate path factor (until learned) |
| `P_capital` | +10% cost | capital-sends-last price |
| `SIM_H` | 48h | simulation horizon |
| `SLOT` | 0.5h | stagger timeline granularity |
| `COVER_TOL` | 98% | requirement coverage acceptance |
| `MAX_REPAIR` | 3 | sim repair passes |
| `COST_SCALE` | 1000 | integer cost scaling |

## P7. Integration map (current → v2)
| Current | v2 fate |
|---|---|
| `dist()` | → `distTorus()` (also used by Analysis/dashboard) |
| `donorFleets/effCap/effSpeed/effShipCap` | kept, feed `Model.fleets` + τ estimates |
| `chooseInterval/allocate/bestAlloc` | superseded by P3 (kept while v1 toggle exists) |
| `optimize / optimizeTroopSupply / optimizeOverflow / optimizeCropCollect` | superseded by the single pipeline (kept behind v1 toggle) |
| `buildAutoPlan` | becomes the orchestrator: `Model → tiers → flows → routes → sim → plan` |
| `routeFlows / netRates / projected` | kept as-is (Analysis of *existing* routes) — v2 plan preview uses the sim's ledger instead |
| `renderUnified` | reused; + diagnosis chips, mode table, diff panel |
| `applyAutoPlan` | → diff-apply; `applyPlan/applyAll` (dead code) deleted |
| Puller `extractTradeRoutes` | + `travelSec`, `kind`; `mergeSyncRoutes` updates `tauCache` |

## P8. Test & acceptance plan (browser harness, synthetic profiles)
1. **Parity:** simple 1-donor/1-drain → v2 ≥ v1 coverage with ≤ carriers.
2. **Phantom regression:** WeakDonor over-provisioned route → sim flags, plan covers the true gap.
3. **Contention:** 4-merchant donor, crop + troop lumber → tier order holds (T0 ≥ T1 ≥ T4), matches the verified c8e90de scenario.
4. **Centralize chain:** collect → forward → distribute; leftovers only on spare carriers.
5. **Torus:** villages (−190,0)/(190,0) → dist 21, not 380.
6. **τ learning:** synced route with `arrivalAt` → cache `learned`, plan intervals reflect real round trip.
7. **Re-injection:** flow below min-route re-routes through a bigger arc instead of vanishing.
8. **Repair:** forced overflow → interval lengthened by sim loop, plan passes second sim.
9. **Determinism:** two consecutive runs on identical state → byte-identical plan (stable sorts everywhere).
10. **Perf:** 25-village synthetic ≤ 100ms end-to-end.

## P9. Implementation stages (unchanged from §7, now mapped to spec sections)
S1 = P0 (torus + τ + puller) · S2 = P1–P3 behind toggle · S3 = P4 + A/B · S4 = P5 modes/diff, default v2 · S5 = polish (deliveries n×, NPC hint, arrival-aware refinements).

**Status: COMPLETE — v2 is the default engine (S1–S5 all done).** Every v2 plan is validated by a 48h discrete-event simulation (partial sends per A1, exact carrier round trips, training burn, overflow loss) with ≤3 targeted repair passes (starvation → interval down + offset 0; overflow → trim inflow; skips → restagger). Crop-routing policies (direct/hub/centralize/auto) select the arc set; Auto compares them lexicographically. Apply is a minimal diff (add/update/delete by from>to>kind identity). Plan hints: carrier-limited → upgrade Trade Office, un-movable crop → NPC merchant, transient low granary → one-time burst-fill (exact sim deficit), excess crop → Capital sink. The summary shows the sim verdict plus an A/B line running the legacy v1 engine on the same state through the same simulator. Full plan+sim+A/B ≈ 5ms, deterministic.**
