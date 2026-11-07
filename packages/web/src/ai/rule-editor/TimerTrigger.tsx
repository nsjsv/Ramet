/* ---------- 规则编辑器：定时触发的表单（一次 / 每天 / 每周 / 每隔）----------
 * 时间按规则的时区算（新规则 = 用户上报过的时区，见 timer-api.ts 的 reportTimeZone），表单下面写明是哪个时区。
 * 四种写法的字段一直在草稿里，切来切去不丢；规整与校验见 rule-model.ts 的 scheduleOf，最终口径在服务端。 */
import { COPY } from '../../copy'
import { DateField } from '../../ui/DateField'
import { Segmented } from '../../ui/form-kit'
import { NumberInput } from '../../ui/NumberInput'
import { EVERY_MAX, EVERY_MIN, normalizeTime, type ScheduleDraft, type ScheduleKind } from './rule-model'

const T = COPY.ai.rule.timer
const KINDS: ScheduleKind[] = ['once', 'daily', 'weekly', 'every']
const WORKDAYS = [1, 2, 3, 4, 5]
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]

const sameDays = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && b.every((d) => a.includes(d))

function hours(minutes: number): string {
  const h = minutes / 60
  return Number.isInteger(h) ? String(h) : h.toFixed(1)
}

export function TimerTrigger({ draft, onChange, timeZone }: { draft: ScheduleDraft; onChange: (d: ScheduleDraft) => void; timeZone: string }) {
  const set = (patch: Partial<ScheduleDraft>): void => onChange({ ...draft, ...patch })
  const toggleDay = (d: number): void => set({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort((a, b) => a - b) })
  const timeField = (
    <label className="rule-field">
      <span>{T.time}</span>
      <input
        className="admin-field rule-time"
        value={draft.time}
        placeholder={T.timePlaceholder}
        inputMode="numeric"
        onChange={(e) => set({ time: e.target.value })}
        // 失焦时把「9」「930」规整成 09:00 / 09:30，用户看得到最后存的是什么
        onBlur={() => {
          const t = normalizeTime(draft.time)
          if (t && t !== draft.time) set({ time: t })
        }}
      />
    </label>
  )
  return (
    <div className="rule-timer">
      <Segmented<ScheduleKind>
        value={draft.kind}
        label={T.kind}
        options={KINDS.map((k) => ({ value: k, label: T.kinds[k] }))}
        onChange={(kind) => set({ kind })}
      />
      <div className="rule-timer-fields">
        {draft.kind === 'once' && (
          <label className="rule-field">
            <span>{T.at}</span>
            <DateField withTime value={draft.at} onChange={(at) => set({ at })} className="rule-date" aria-label={T.at} />
          </label>
        )}
        {draft.kind === 'daily' && timeField}
        {draft.kind === 'weekly' && (
          <>
            <div className="rule-field">
              <span>{T.days}</span>
              <div className="rule-days" role="group" aria-label={T.days}>
                {ALL_DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={'rule-day' + (draft.days.includes(d) ? ' is-on' : '')}
                    aria-pressed={draft.days.includes(d)}
                    data-tip={T.dayTip(T.dayNames[d - 1]!)}
                    onClick={() => toggleDay(d)}
                  >
                    {T.dayNames[d - 1]}
                  </button>
                ))}
                <button type="button" className={'rule-day-preset' + (sameDays(draft.days, WORKDAYS) ? ' is-on' : '')} onClick={() => set({ days: WORKDAYS })}>
                  {T.workdays}
                </button>
                <button type="button" className={'rule-day-preset' + (sameDays(draft.days, ALL_DAYS) ? ' is-on' : '')} onClick={() => set({ days: ALL_DAYS })}>
                  {T.everyDay}
                </button>
              </div>
            </div>
            {timeField}
          </>
        )}
        {draft.kind === 'every' && (
          <label className="rule-field">
            <span>{T.minutes}</span>
            <span className="rule-inline">
              <NumberInput
                className="admin-field rule-minutes"
                integer
                min={EVERY_MIN}
                max={EVERY_MAX}
                step={30}
                value={draft.minutes}
                onChange={(minutes) => set({ minutes })}
                aria-label={T.minutes}
              />
              <span className="rule-muted">{draft.minutes ? T.asHours(hours(draft.minutes)) : T.minutesHint(EVERY_MIN, EVERY_MAX)}</span>
            </span>
          </label>
        )}
      </div>
      <p className="rule-muted">{COPY.ai.rule.zone(timeZone)}</p>
    </div>
  )
}
