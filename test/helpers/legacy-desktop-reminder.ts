/**
 * 第 57 轮 P1-E：`createReminder` 现在直接拒绝桌面渠道（返回 `unsupported-channel`，零写入）。
 *
 * 但「历史桌面提醒」仍然存在：本次改动**不迁移**旧数据，它们继续躺在 `reminders` 里，
 * 派发链路的 `desktop-channel` 跳过分支仍要能处理它们（卡片不再展示这些行）。
 * 需要造这种历史行的测试用这个 helper 直接 INSERT，而不是走 `createReminder`。
 */
export interface LegacyDesktopReminderInput {
  db: { run(sql: string, params?: readonly (string | number | null)[]): unknown }
  reminderId: string
  dueAt: string
  text: string
  sessionRef: string
  now: string
  requestId?: string
  personaId?: string
}

export function insertLegacyDesktopReminder(input: LegacyDesktopReminderInput): string {
  const personaId = input.personaId ?? 'main'
  input.db.run(
    `INSERT INTO reminders (
       reminder_id, persona_id, channel, contact_id, session_ref, due_at, timezone,
       text, request_id, status, created_at, updated_at, cancelled_at, fired_at,
       delivery_state, last_attempt_at, access_epoch
     ) VALUES (?, ?, 'desktop', NULL, ?, ?, 'Asia/Shanghai', ?, ?, 'pending', ?, ?, NULL, NULL, 'unsupported', NULL, NULL)`,
    [
      input.reminderId,
      personaId,
      input.sessionRef,
      input.dueAt,
      input.text,
      input.requestId ?? `legacy-${input.reminderId}`,
      input.now,
      input.now,
    ],
  )
  return input.reminderId
}
