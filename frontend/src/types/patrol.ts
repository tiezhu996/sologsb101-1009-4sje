/** 巡检：按计划日期生成的巡检任务 */
export type PatrolState = '待巡检' | '已完成' | '漏检'

export interface Patrol {
  id: string
  stationId: string
  /** 计划日期 YYYY-MM-DD */
  planDate: string
  /** 实际日期，未执行时为空串 */
  patrolDate: string
  patrolman: string
  envNote: string
  state: PatrolState
  createdAt: number
  updatedAt: number
}

export const PATROL_STATES: PatrolState[] = ['待巡检', '已完成', '漏检']

/** 巡检状态机：待巡检 → 已完成；漏检 → 已完成（补检） */
export const PATROL_STATE_FLOW: Record<PatrolState, PatrolState | null> = {
  待巡检: '已完成',
  已完成: null,
  漏检: '已完成'
}

export interface PatrolDraft {
  stationId: string
  planDate: string
  patrolDate: string
  patrolman: string
  envNote: string
  state: PatrolState
}

export const EMPTY_PATROL_DRAFT: PatrolDraft = {
  stationId: '',
  planDate: '',
  patrolDate: '',
  patrolman: '',
  envNote: '',
  state: '待巡检'
}

/** 漏检条目：超期天数由计划日期与当前日期推导 */
export interface PatrolGap {
  patrol: Patrol
  /** 超期天数（计划日期距今天数） */
  overdueDays: number
  /** 是否已超期未检 */
  overdue: boolean
  /** 提示文案 */
  text: string
}

export function patrolLabel(patrol: Patrol, stationName: string): string {
  return `${stationName} · 计划 ${patrol.planDate}`
}

/**
 * 读数判定的基准日期：已完成按实际巡检日期，未完成按计划日期。
 * 未完成的计划不会提前套用未来生效的新标准。
 */
export function patrolBaseDate(patrol: Pick<Patrol, 'patrolDate' | 'planDate'> | null | undefined): string {
  const fallback = new Date().toISOString().slice(0, 10)
  if (!patrol) return fallback
  return patrol.patrolDate || patrol.planDate || fallback
}
