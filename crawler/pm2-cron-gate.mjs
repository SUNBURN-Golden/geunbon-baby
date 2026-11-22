import schedule from './pm2-cron.cjs';

// PM2 also launches these registrations on start/resurrect. Only a start in
// the scheduled minute (or the next minute, allowing dispatch delay) runs work.
const name = process.env.AGAMAJUNG_PM2_JOB;
const minute = schedule.kstMinute(new Date());
if (!Object.hasOwn(schedule.slots, name) ||
    !schedule.slotMinutes(name).some(slot => minute === slot || minute === slot + 1)) process.exit(0);
