/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point, StandardVersion } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import { patrolBaseDate } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import { deviationPctOf, judgeReading, resolveStandardVersion } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
  standardVersions: StandardVersion[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned
export type StandardVersionRow = StandardVersion & Revisioned

/** 时间戳 → 本地 YYYY-MM-DD（版本生效日期、迁移补版本时用） */
export function localDateOf(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>
  standardVersions!: Table<StandardVersionRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(2)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

        // 迁移：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        // 迁移：读数补 note，并按偏差率重算 isAbnormal / deviationPct
        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })
      })

    // v3：标准值版本化——新增 standardVersions 表；既有标准补为 v1（生效日期取点位创建日）；
    // 读数回填 standardVersionId，历史判定按 v1 重算（与既有结果一致，不再随改值漂移）
    this.version(DB_VERSION)
      .stores({
        standardVersions: 'id, pointId, effectiveDate, version'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
          createdAt?: number
        }>
        const v1Rows: StandardVersionRow[] = points.map((point) => ({
          id: `sv1-${point.id}`,
          pointId: point.id,
          version: 1,
          effectiveDate: localDateOf(typeof point.createdAt === 'number' ? point.createdAt : now),
          standardMin: point.standardMin,
          standardMax: point.standardMax,
          isCritical: point.isCritical === true,
          reason: '既有标准初始版本',
          createdAt: now,
          updatedAt: now,
          revision: ROW_REVISION
        }))
        if (v1Rows.length > 0) await tx.table('standardVersions').bulkPut(v1Rows)

        const v1ByPoint = new Map(v1Rows.map((row) => [row.pointId, row]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            const version = v1ByPoint.get(String(reading.pointId))
            if (!version) {
              if (typeof reading.standardVersionId !== 'string') reading.standardVersionId = ''
              return
            }
            reading.standardVersionId = version.id
            const value = Number(reading.value)
            if (Number.isFinite(value)) {
              const judgement = judgeReading(value, version.standardMin, version.standardMax, version.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            }
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用标准版本：每个点位的初始标准记为 v1，生效日期取点位创建日 */
const SEED_STANDARD_VERSIONS: StandardVersionRow[] = SEED_POINTS.map((point, index) => ({
  id: `sv-${index + 1}`,
  pointId: point.id,
  version: 1,
  effectiveDate: localDateOf(point.createdAt),
  standardMin: point.standardMin,
  standardMax: point.standardMax,
  isCritical: point.isCritical,
  reason: '初始标准',
  createdAt: point.createdAt,
  updatedAt: point.updatedAt,
  revision: ROW_REVISION
}))

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注] */
const SEED_READING_ROWS: Array<[string, string, number, string]> = [
  ['pa-1', 'pt-1', 0.41, ''],
  ['pa-1', 'pt-2', 0.23, ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味'],
  ['pa-2', 'pt-1', 0.38, ''],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度'],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹'],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏'],
  ['pa-4', 'pt-7', 0.21, ''],
  ['pa-4', 'pt-8', 0.145, ''],
  ['pa-4', 'pt-9', 12, ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高']
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

/** 由原始行派生偏差率与异常标记（判定用点位 v1 版本，并记录所用版本 id） */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const version = SEED_STANDARD_VERSIONS.find((item) => item.pointId === pointId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      standardVersionId: version ? version.id : '',
      note,
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.standardVersions.bulkPut(SEED_STANDARD_VERSIONS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(SEED_LEAKS)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

export async function deletePointCascade(pointId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions],
      async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.standardVersions.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  const pointIds = (await db.points.where('deviceId').anyOf(deviceIds).toArray()).map((point) => point.id)
  if (pointIds.length > 0) await db.standardVersions.where('pointId').anyOf(pointIds).delete()
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

/** 写入读数：按巡检基准日期匹配标准版本判定，落 isAbnormal / deviationPct / standardVersionId */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const [point, patrol, versions] = await Promise.all([
    db.points.get(row.pointId),
    db.patrols.get(row.patrolId),
    db.standardVersions.where('pointId').equals(row.pointId).toArray()
  ])
  const version = resolveStandardVersion(versions, row.pointId, patrolBaseDate(patrol ?? null))
  const min = version ? version.standardMin : point ? point.standardMin : 0
  const max = version ? version.standardMax : point ? point.standardMax : 1
  const critical = version ? version.isCritical : point ? point.isCritical : false
  const judgement = point ? judgeReading(row.value, min, max, critical) : { isAbnormal: false, deviationPct: 0 }
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    standardVersionId: version ? version.id : '',
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/**
 * 按版本重算某点位全部读数：每条读数按其巡检基准日期匹配版本判定。
 * 基准日期早于新版本生效日的旧巡检仍命中旧版本，判定结果保持不变。
 */
export async function recalculateReadingsOfPoint(pointId: string): Promise<void> {
  const point = await db.points.get(pointId)
  if (!point) return
  const rows = await db.readings.where('pointId').equals(pointId).toArray()
  if (rows.length === 0) return
  const versions = await db.standardVersions.where('pointId').equals(pointId).toArray()
  const patrolIds = Array.from(new Set(rows.map((row) => row.patrolId)))
  const patrolRows = await db.patrols.bulkGet(patrolIds)
  const patrolMap = new Map<string, PatrolRow>()
  patrolRows.forEach((patrol) => {
    if (patrol) patrolMap.set(patrol.id, patrol)
  })
  const now = Date.now()
  await db.readings.bulkPut(
    rows.map((row) => {
      const baseDate = patrolBaseDate(patrolMap.get(row.patrolId) ?? null)
      const version = resolveStandardVersion(versions, pointId, baseDate)
      const min = version ? version.standardMin : point.standardMin
      const max = version ? version.standardMax : point.standardMax
      const critical = version ? version.isCritical : point.isCritical
      const judgement = judgeReading(row.value, min, max, critical)
      return {
        ...row,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        standardVersionId: version ? version.id : row.standardVersionId ?? '',
        updatedAt: now
      }
    })
  )
}

/** 巡检实际日期确定/变更后调用：按新基准日期重算该次巡检的全部读数 */
export async function recalculateReadingsOfPatrol(patrolId: string): Promise<void> {
  const rows = await db.readings.where('patrolId').equals(patrolId).toArray()
  if (rows.length === 0) return
  const patrol = (await db.patrols.get(patrolId)) ?? null
  const baseDate = patrolBaseDate(patrol)
  const pointIds = Array.from(new Set(rows.map((row) => row.pointId)))
  const [pointRows, versions] = await Promise.all([
    db.points.bulkGet(pointIds),
    db.standardVersions.where('pointId').anyOf(pointIds).toArray()
  ])
  const pointMap = new Map<string, PointRow>()
  pointRows.forEach((point) => {
    if (point) pointMap.set(point.id, point)
  })
  const now = Date.now()
  await db.readings.bulkPut(
    rows.map((row) => {
      const point = pointMap.get(row.pointId)
      const version = resolveStandardVersion(versions, row.pointId, baseDate)
      const min = version ? version.standardMin : point ? point.standardMin : 0
      const max = version ? version.standardMax : point ? point.standardMax : 1
      const critical = version ? version.isCritical : point ? point.isCritical : false
      const judgement = judgeReading(row.value, min, max, critical)
      return {
        ...row,
        isAbnormal: judgement.isAbnormal,
        deviationPct: judgement.deviationPct,
        standardVersionId: version ? version.id : row.standardVersionId ?? '',
        updatedAt: now
      }
    })
  )
}

/* ============================ 标准版本提交 ============================ */

export interface CommitStandardPayload {
  pointId: string
  standardMin: number
  standardMax: number
  isCritical: boolean
  /** 生效日期 YYYY-MM-DD，自该日起的巡检按此版本判定 */
  effectiveDate: string
  /** 调整原因（季节切换 / 检修后调整等） */
  reason: string
}

/**
 * 提交标准值版本：
 * - 同一生效日期重复提交 → 覆盖该版本（以最后一次提交为准），不新增版本号，
 *   保证同次巡检前后保存命中同一版本，不会出现两种异常级别；
 * - 不同生效日期 → 新增版本，版本号递增，历史版本保留。
 * 提交后把点位当前标准值同步为「截至今天已生效的最新版本」（未来生效的不提前套用），
 * 并按版本重算该点位读数。
 */
export async function commitStandardVersion(
  payload: CommitStandardPayload
): Promise<{ row: StandardVersionRow; overwritten: boolean }> {
  const now = Date.now()
  const existing = await db.standardVersions.where('pointId').equals(payload.pointId).toArray()
  const sameDay = existing.find((item) => item.effectiveDate === payload.effectiveDate)
  let row: StandardVersionRow
  let overwritten = false
  if (sameDay) {
    row = {
      ...sameDay,
      standardMin: payload.standardMin,
      standardMax: payload.standardMax,
      isCritical: payload.isCritical,
      reason: payload.reason,
      updatedAt: now
    }
    overwritten = true
    await db.standardVersions.put(row)
  } else {
    const nextVersion = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1
    row = {
      id: createId('sv'),
      pointId: payload.pointId,
      version: nextVersion,
      effectiveDate: payload.effectiveDate,
      standardMin: payload.standardMin,
      standardMax: payload.standardMax,
      isCritical: payload.isCritical,
      reason: payload.reason,
      createdAt: now,
      updatedAt: now,
      revision: ROW_REVISION
    }
    await db.standardVersions.put(row)
  }

  const all = await db.standardVersions.where('pointId').equals(payload.pointId).toArray()
  const current = resolveStandardVersion(all, payload.pointId, localDateOf(now))
  if (current) {
    await db.points.update(payload.pointId, {
      standardMin: current.standardMin,
      standardMax: current.standardMax,
      isCritical: current.isCritical,
      updatedAt: now
    })
  }
  await recalculateReadingsOfPoint(payload.pointId)
  return { row, overwritten }
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count(),
    db.standardVersions.count()
  ])
  return { stations, devices, points, patrols, readings, leaks, standardVersions }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks, standardVersions] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray(),
    db.standardVersions.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip),
    standardVersions: standardVersions.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.standardVersions.clear()
    ])
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    await db.stations.bulkPut((payload.stations ?? []).map(rev))
    await db.devices.bulkPut((payload.devices ?? []).map(rev))
    await db.points.bulkPut((payload.points ?? []).map(rev))
    await db.patrols.bulkPut((payload.patrols ?? []).map(rev))
    await db.readings.bulkPut((payload.readings ?? []).map(rev))
    await db.leaks.bulkPut((payload.leaks ?? []).map(rev))
    await db.standardVersions.bulkPut((payload.standardVersions ?? []).map(rev))
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks, db.standardVersions],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear(),
      db.standardVersions.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
