const slots = {
  'agamajung-discover': '20 9,15,21 * * *',
  'agamajung-collect': '40 9,15,21 * * *',
  'agamajung-discover-sources': '5 10 * * *',
  'agamajung-backfill': '30 3 * * *',
  'agamajung-crawler': '30 9,20 * * *',
};

function kstMinute(now) {
  const date = new Date(now.getTime() + 9 * 3_600_000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function slotMinutes(name) {
  const [minute, hours] = slots[name].split(' ');
  return hours.split(',').map(hour => Number(hour) * 60 + Number(minute));
}

const collectorCommands = {
  'agamajung-discover': 'discover',
  'agamajung-collect': 'collect',
  'agamajung-discover-sources': 'discover-sources',
  'agamajung-backfill': 'backfill-engine',
};

function isPm2CollectorJob(command) {
  return typeof command === 'string' && collectorCommands[process.env.AGAMAJUNG_PM2_JOB] === command;
}

function collectorSlotTimes() {
  return slotMinutes(process.env.AGAMAJUNG_PM2_JOB).map(slot =>
    [Math.floor(slot / 60), slot % 60].map(part => String(part).padStart(2, '0')).join(':'));
}

module.exports = { slots, kstMinute, slotMinutes, isPm2CollectorJob, collectorSlotTimes };
