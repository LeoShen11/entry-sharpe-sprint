# entry-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/LeoShen11/entry-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/LeoShen11/entry-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A disciplined paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty. One strategy program, `main.ts` on Node 22, trading paper money on a 6-hour pump.fun forward replay. Places go by hourly Sharpe ratio, so the bot aims for steady, controlled gains: small equal stakes (0.10 SOL), quick take-profit (+18%) and tight stop-loss (-10%), a trailing stop, and a sell-off exit. A pacing probe keeps round trips on pace for the 20-coin minimum.

## Run it

```sh
node main.ts
```

The harness drives it over stdin/stdout with the agent-fun/replay/v2 protocol (hello, batch, done); the bot answers one reply per batch. No network, no files, no dependencies.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6nk0p130&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
