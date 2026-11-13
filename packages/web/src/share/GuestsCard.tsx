/* ---------- 空间设置里的「访客」卡（空间 owner）：服务端 routes/space-guests.ts ----------
 * 访客 = 有页分享给他、又不是这个空间成员的人。按人列出：公共区的页给标题，私人区的页只给数量（owner 也看不到别人的私人区）；
 * 「移出空间」删他在这个空间收到的全部分享。开关「成员可以邀请访客」：关掉后只有 owner 能把页分享给空间外的人。 */
import { useCallback, useEffect, useState } from 'react'
import { Card, ConfirmButton, Row, Switch } from '../ui/form-kit'
import { guestsApi, type SpaceGuests } from './share-api'
import { GUESTS_COPY as C } from './share-copy'

export default function GuestsCard({ spaceId, onError }: { spaceId: string; onError: (msg: string | null) => void }) {
  const [data, setData] = useState<SpaceGuests | null>(null)
  const load = useCallback(() => {
    guestsApi.list(spaceId).then(setData, (err: unknown) => {
      console.error(err)
      onError(C.loadFailed)
    })
  }, [spaceId, onError])
  useEffect(load, [load])

  async function setPolicy(on: boolean): Promise<void> {
    onError(null)
    try {
      await guestsApi.setPolicy(spaceId, on)
      load()
    } catch (err) {
      console.error(err)
      onError(C.failed)
    }
  }

  async function remove(userId: string): Promise<void> {
    onError(null)
    try {
      await guestsApi.remove(spaceId, userId)
      load()
    } catch (err) {
      console.error(err)
      onError(C.failed)
    }
  }

  return (
    <Card title={data ? C.title(data.guests.length) : C.titleBare}>
      <Row label={C.policy} desc={C.policyDesc} htmlFor="guests-policy">
        <Switch id="guests-policy" label={C.policy} checked={data?.membersInvite ?? true} onChange={(on) => void setPolicy(on)} />
      </Row>
      {data === null && <p className="set-empty">{C.loading}</p>}
      {data?.guests.length === 0 && <p className="set-empty">{C.empty}</p>}
      {data?.guests.map((g) => (
        <div className="set-line" key={g.userId}>
          <div className="set-line-main">
            <span className="set-line-name" data-tip={g.username}>
              {g.username}
            </span>
            <span className="set-line-sub">{C.pages(g.pages.map((p) => p.title || C.untitled), g.privateCount)}</span>
          </div>
          <ConfirmButton confirmLabel={C.removeConfirm} onConfirm={() => void remove(g.userId)} tip={C.removeTip(g.username)}>
            {C.remove}
          </ConfirmButton>
        </div>
      ))}
    </Card>
  )
}
