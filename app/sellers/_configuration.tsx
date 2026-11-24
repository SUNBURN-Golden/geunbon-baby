import { sellersCopy as copy } from '../../lib/copy/sellers.ko';
import { historySelection, type HistoryConfiguration } from '../../lib/deals';

export function ConfigurationSelector({ path, options, selected }: {
  path: string; options: HistoryConfiguration[]; selected?: HistoryConfiguration;
}) {
  if (options.length < 2) return null;
  return <form action={path}>
    <label>{copy.configuration}{' '}
      <select name="configuration" defaultValue={selected && historySelection(selected)}>
        {options.map(entry => {
          const value = historySelection(entry);
          const configuration = JSON.parse(entry.configuration_key) as string[];
          return <option key={value} value={value}>
            {entry.brand} {entry.name} · {configuration.slice(2).join(' · ')}
          </option>;
        })}
      </select>
    </label>{' '}
    <button>{copy.compareProduct}</button>
  </form>;
}
