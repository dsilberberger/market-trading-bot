import { formatISODate } from '../core/time';

const printSchedule = () => {
  const today = formatISODate(new Date());
  console.log('Example cron (UTC) to dump then trade weekly on Friday 23:55/23:57:');
  console.log('# m h dom mon dow cmd');
  console.log('55 23 * * FRI cd $(pwd) && npm run bot:dump -- --asof $(date -u +%Y-%m-%dT23:55)');
  console.log('57 23 * * FRI cd $(pwd) && npm run bot:trade -- --asof $(date -u +%Y-%m-%dT23:55) --strategy llm --mode paper');
  console.log('');
  console.log('macOS launchd example (weekly Friday 23:55 UTC):');
  console.log(`<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.tradingbot.dump</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd ${process.cwd()} && npm run bot:dump -- --asof $(date -u +%Y-%m-%dT23:55)</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>6</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>55</integer></dict>
</dict>
</plist>`);
  console.log('');
  console.log(`Today is ${today}. Adjust --asof if you test manually.`);
};

printSchedule();
