# DP Shop Temperature Monitor

Checks every Govee thermometer on the account every 15 minutes. Each GitHub run checks every 15 minutes for about 5.5 hours, then starts the next run itself, so no outside timer is needed; a 6-hourly schedule restarts it if the chain ever stops. To restart by hand: Actions > Shop temperature monitor > Run workflow > monitor. To stop it: cancel the running run. If a shop is outside 18-23°C during opening hours, it messages that shop's Slack channel to put the heating or cooling on for an hour, follows up, tells them to switch it off when back in range, and escalates to the area supervisor channel if it hasn't recovered after 2 hours. A live dashboard is rebuilt on every run.

## What the shop sees

| When | Message |
|---|---|
| Goes below 18°C / above 23°C | TEMPERATURE ALERT - turn the HEATING / COOLING ON for 1 hour |
| Still out of range after 1 hour | STILL TOO COLD / WARM - check it's on, keep it on another hour (max 3 shop alerts) |
| Back in range | BACK IN RANGE - switch the HEATING / COOLING OFF |
| Still out after 2 hours | ESCALATION to the supervisor channel - possible heating/cooling fault |
| Sensor silent 45 min | SENSOR OFFLINE to the supervisor channel |

Out-of-hours breaches are recorded but not messaged; the shop gets the alert at opening if it's still out of range. A shop must reach 18.3°C / 22.7°C to count as recovered, so readings hovering on the line don't send a stream of on/off messages.

## Overnight check (management only, never sent to Slack)

Every night the monitor records each shop's temperature at closing and then every 15 minutes until morning. At 05:00 it compares the 01:00-05:00 readings against the closing temperature and against the rest of the estate, then writes `data/overnight.json`. A daily Claude scheduled task reads that file and reports flagged shops in Claude.

| Flag | Rule |
|---|---|
| Heating likely left on | Warmed up by 0.5°C+ after closing, went above 23°C, or held above 19.5°C while dropping at least 2°C less than most shops |
| Cooling likely left on | Fell below 16°C and dropped at least 2°C more than most shops |

The 05:00 cut-off means timed pre-heat before opening is not flagged. The report also lists sensors with no overnight data and how many of the last 14 nights each flagged shop has been flagged, so repeat offenders stand out. Thresholds are under `overnight` in `config.json`.

## Setup (about 30 minutes)

### 1. Rotate the Govee API key
The key was shared in a chat. Request a new one in the Govee Home app (Profile > Settings > Apply for API Key) and use only the new one below.

### 2. Create a Slack app
1. https://api.slack.com/apps > Create New App > From scratch, in the DP workspace.
2. OAuth & Permissions > Bot Token Scopes: add `chat:write`.
3. Install to workspace and copy the **Bot User OAuth Token** (starts `xoxb-`).
4. In each shop channel and the supervisor channel, type `/invite @YourAppName`.
5. Get each channel ID: right-click the channel > View channel details > the ID is at the bottom (starts `C`).

### 3. Create the GitHub repository
1. New repository (public - see note below), upload all files in this folder keeping the folder structure.
2. Settings > Secrets and variables > Actions > New repository secret:
   - `GOVEE_API_KEY` = the new Govee key
   - `SLACK_BOT_TOKEN` = the `xoxb-` token
3. Settings > Pages > Source: Deploy from a branch > `main` / `/docs`. The dashboard URL appears there.

### 4. Map sensors to shops
1. Actions tab > Shop temperature monitor > Run workflow > mode **list-devices**.
2. Open the run log: it lists every sensor name on the Govee account.
3. Edit `config.json` > `shops`, one entry per sensor:
   ```json
   { "goveeName": "Walton", "shop": "Walton Rice Lane", "area": "Liverpool", "slackChannel": "C07ABC123" }
   ```
   `goveeName` must match the sensor's name in the Govee app. Unmapped sensors still show on the dashboard and alert `defaultShopChannel`.
4. Set `slack.defaultShopChannel` and `slack.escalationChannel`, and check `openingHours`.

### 5. Test, then go live
1. Run workflow > mode **dry-run**: checks real sensors, prints the Slack messages it would send, sends nothing.
2. Run workflow > mode **monitor**: live. From then on it runs every 15 minutes by itself.

## Settings (`config.json`)

| Setting | Default | Meaning |
|---|---|---|
| `comfort.min` / `max` | 18 / 23 | Comfortable range °C |
| `recoveryMargin` | 0.3 | How far inside the range counts as recovered |
| `realertAfterMinutes` | 60 | Gap between follow-ups to the shop |
| `maxShopAlerts` | 3 | Shop messages per breach before leaving it to the supervisor |
| `escalateAfterMinutes` | 120 | Time from first alert to supervisor escalation |
| `offlineAfterMinutes` | 45 | Silence before a sensor is flagged offline |
| `temperatureUnitFromGovee` | auto | Govee often returns °F; `auto` converts anything above 45. Set `C` or `F` to force |
| `openingHours` | 08:30-22:00, Sun 09:30-20:00 | UK time; messages only sent inside these |

## Notes
- **Public repo**: free unlimited Actions minutes; a private repo on the free plan would use ~2,900 of its 2,000 monthly minutes. Keys stay in Secrets and are never visible. The dashboard and `config.json` (shop names, channel IDs) are publicly readable - fine for temperatures, but don't add anything else sensitive.
- GitHub can delay scheduled runs by 5-15 minutes at busy times. The dashboard shows a warning if data is over 40 minutes old.
- Govee allows 10,000 requests a day; 36 sensors every 15 minutes uses about 3,500.
- Local test without hardware: `MOCK=1 DRY_RUN=1 node src/monitor.js`
