/**
 * 站点、设备与点位状态（Zustand）
 * 维护站点/设备/点位列表、当前选中站点与筛选条件（点位作为设备的标准值档案一并维护）。
 * 标准值变更按生效日期生成版本，读数按实际巡检日期匹配版本判定，改值不回算历史读数。
 * 数据通过模块级 liveQuery 订阅 Dexie，写入后自动回流。
 */
import { create } from 'zustand'
import { liveQuery } from 'dexie'
import {
  commitStandardVersion,
  createId,
  db,
  deleteDeviceCascade,
  deletePointCascade,
  deleteStationCascade,
  readUiPrefs,
  writeUiPrefs,
  type DeviceRow,
  type PointRow,
  type StationRow,
  type StandardVersionRow
} from '@/utils/db'
import type { Device, DeviceDraft, DeviceState, DeviceType } from '@/types/device'
import type { Point, PointDraft, PointFilterState, PointTemplate, StandardDraft } from '@/types/point'
import { createEmptyPointFilter } from '@/types/point'
import type { StandardVersion } from '@/types/standard'
import { matchStandardVersion, sortVersions } from '@/types/standard'
import type { Station, StationDraft, StationGrade } from '@/types/station'
import { todayText } from '@/utils/range'

export interface StationFilterState {
  keyword: string
  grades: StationGrade[]
  deviceTypes: DeviceType[]
}

export function createEmptyStationFilter(): StationFilterState {
  return { keyword: '', grades: [], deviceTypes: [] }
}

interface StationState {
  stations: Station[]
  devices: Device[]
  points: Point[]
  /** 全部点位的标准版本（含历史版本），按 liveQuery 回流 */
  standardVersions: StandardVersion[]
  currentStationId: string | null
  filter: StationFilterState
  pointFilter: PointFilterState
  /** 标准值编辑草稿：点位 id → 待提交的上下限与生效日期 */
  standardDraft: Record<string, StandardDraft>
  ready: boolean
  selectStation: (id: string | null) => void
  patchFilter: (patch: Partial<StationFilterState>) => void
  resetFilter: () => void
  patchPointFilter: (patch: Partial<PointFilterState>) => void
  resetPointFilter: () => void
  createStation: (draft: StationDraft) => Promise<Station>
  updateStation: (id: string, patch: Partial<StationDraft>) => Promise<void>
  removeStation: (id: string) => Promise<void>
  createDevice: (draft: DeviceDraft) => Promise<Device>
  updateDevice: (id: string, patch: Partial<DeviceDraft>) => Promise<void>
  removeDevice: (id: string) => Promise<void>
  createPoint: (draft: PointDraft) => Promise<Point>
  /** 更新点位；标准值有改动时按当天生效存为新版本，返回是否产生了版本变更 */
  updatePoint: (id: string, patch: Partial<PointDraft>) => Promise<boolean>
  removePoint: (id: string) => Promise<void>
  applyTemplate: (deviceId: string, templates: PointTemplate[]) => Promise<number>
  setStandardDraft: (pointId: string, draft: StandardDraft) => void
  clearStandardDraft: (pointId?: string) => void
  /** 提交单个点位的标准草稿：同一生效日期覆盖当次版本，否则新增版本 */
  commitStandardDraft: (pointId: string) => Promise<StandardVersion | null>
  commitAllStandardDrafts: () => Promise<number>
  devicesOfStation: (stationId: string) => Device[]
  pointsOfDevice: (deviceId: string) => Point[]
  /** 某点位的全部标准版本（按版本号升序） */
  versionsOfPoint: (pointId: string) => StandardVersion[]
  /** 某点位当前（版本号最大）的标准版本 */
  latestVersionOf: (pointId: string) => StandardVersion | null
  /** 按日期匹配生效版本（无版本记录时返回 null） */
  matchVersion: (pointId: string, date: string) => StandardVersion | null
  versionById: (id: string) => StandardVersion | null
  currentStation: () => Station | null
  filteredStations: () => Station[]
  pointStats: () => { total: number; critical: number }
}

export const useStationStore = create<StationState>((set, get) => ({
  stations: [],
  devices: [],
  points: [],
  standardVersions: [],
  currentStationId: readUiPrefs().lastStationId,
  filter: createEmptyStationFilter(),
  pointFilter: createEmptyPointFilter(),
  standardDraft: {},
  ready: false,

  selectStation(id) {
    set({ currentStationId: id })
    writeUiPrefs({ ...readUiPrefs(), lastStationId: id })
  },

  patchFilter(patch) {
    set({ filter: { ...get().filter, ...patch } })
  },

  resetFilter() {
    set({ filter: createEmptyStationFilter() })
  },

  patchPointFilter(patch) {
    set({ pointFilter: { ...get().pointFilter, ...patch } })
  },

  resetPointFilter() {
    set({ pointFilter: createEmptyPointFilter() })
  },

  async createStation(draft) {
    const now = Date.now()
    const row: StationRow = {
      id: createId('st'),
      name: draft.name.trim(),
      location: draft.location.trim(),
      designFlowM3h: Number(draft.designFlowM3h) || 0,
      inletPressureMpa: Number(draft.inletPressureMpa) || 0,
      grade: draft.grade,
      commissionDate: draft.commissionDate,
      createdAt: now,
      updatedAt: now
    }
    await db.stations.put(row)
    get().selectStation(row.id)
    return row
  },

  async updateStation(id, patch) {
    const next: Partial<StationRow> = { ...patch, updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.location !== undefined) next.location = patch.location.trim()
    await db.stations.update(id, next)
  },

  async removeStation(id) {
    await deleteStationCascade(id)
    if (get().currentStationId === id) {
      const fallback = get().stations.find((station) => station.id !== id) ?? null
      get().selectStation(fallback ? fallback.id : null)
    }
  },

  async createDevice(draft) {
    const now = Date.now()
    const row: DeviceRow = {
      id: createId('dv'),
      stationId: draft.stationId || get().currentStationId || '',
      type: draft.type,
      model: draft.model.trim(),
      serialNo: draft.serialNo.trim(),
      installDate: draft.installDate,
      state: draft.state,
      createdAt: now,
      updatedAt: now
    }
    await db.devices.put(row)
    return row
  },

  async updateDevice(id, patch) {
    const next: Partial<DeviceRow> = { ...patch, updatedAt: Date.now() }
    if (patch.model !== undefined) next.model = patch.model.trim()
    if (patch.serialNo !== undefined) next.serialNo = patch.serialNo.trim()
    await db.devices.update(id, next)
  },

  async removeDevice(id) {
    await deleteDeviceCascade(id)
  },

  async createPoint(draft) {
    const now = Date.now()
    const device = await db.devices.get(draft.deviceId)
    const row: PointRow = {
      id: createId('pt'),
      deviceId: draft.deviceId,
      stationId: device ? device.stationId : '',
      name: draft.name.trim(),
      standardMin: Number(draft.standardMin) || 0,
      standardMax: Number(draft.standardMax) || 0,
      unit: draft.unit,
      isCritical: draft.isCritical,
      createdAt: now,
      updatedAt: now
    }
    await db.points.put(row)
    // 新点位：现行标准落为第一版，当天生效
    await commitStandardVersion(row.id, {
      standardMin: row.standardMin,
      standardMax: row.standardMax,
      isCritical: row.isCritical,
      effectiveDate: todayText()
    })
    return row
  },

  async updatePoint(id, patch) {
    const current = get().points.find((point) => point.id === id)
    const next: Partial<PointRow> = { ...patch, updatedAt: Date.now() }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.deviceId !== undefined) {
      const device = await db.devices.get(patch.deviceId)
      if (device) next.stationId = device.stationId
    }
    await db.points.update(id, next)
    if (!current) return false
    const min = Number(patch.standardMin ?? current.standardMin)
    const max = Number(patch.standardMax ?? current.standardMax)
    const isCritical = patch.isCritical ?? current.isCritical
    const standardChanged =
      min !== current.standardMin || max !== current.standardMax || isCritical !== current.isCritical
    if (!standardChanged) return false
    // 标准值变更：按当天生效存为新版本（同日再改覆盖），历史读数判据不变
    await commitStandardVersion(id, {
      standardMin: Math.min(min, max),
      standardMax: Math.max(min, max),
      isCritical,
      effectiveDate: todayText()
    })
    return true
  },

  async removePoint(id) {
    await deletePointCascade(id)
    get().clearStandardDraft(id)
  },

  async applyTemplate(deviceId, templates) {
    const device = await db.devices.get(deviceId)
    const stationId = device ? device.stationId : ''
    const existing = get().points.filter((point) => point.deviceId === deviceId).map((point) => point.name)
    const now = Date.now()
    const rows: PointRow[] = templates
      .filter((template) => !existing.includes(template.name))
      .map((template) => ({
        id: createId('pt'),
        deviceId,
        stationId,
        name: template.name,
        standardMin: template.standardMin,
        standardMax: template.standardMax,
        unit: template.unit,
        isCritical: template.isCritical,
        createdAt: now,
        updatedAt: now
      }))
    if (rows.length > 0) {
      await db.points.bulkPut(rows)
      // 模板复制的点位：各自现行标准落为第一版，当天生效
      for (const row of rows) {
        await commitStandardVersion(row.id, {
          standardMin: row.standardMin,
          standardMax: row.standardMax,
          isCritical: row.isCritical,
          effectiveDate: todayText()
        })
      }
    }
    return rows.length
  },

  setStandardDraft(pointId, draft) {
    set({ standardDraft: { ...get().standardDraft, [pointId]: draft } })
  },

  clearStandardDraft(pointId) {
    if (pointId === undefined) {
      set({ standardDraft: {} })
      return
    }
    const next = { ...get().standardDraft }
    delete next[pointId]
    set({ standardDraft: next })
  },

  async commitStandardDraft(pointId) {
    const draft = get().standardDraft[pointId]
    if (!draft) return null
    const min = Math.min(draft.standardMin, draft.standardMax)
    const max = Math.max(draft.standardMin, draft.standardMax)
    const saved = await commitStandardVersion(pointId, {
      standardMin: min,
      standardMax: max > min ? max : min + 0.001,
      isCritical: draft.isCritical,
      effectiveDate: draft.effectiveDate || todayText()
    })
    get().clearStandardDraft(pointId)
    return saved
  },

  async commitAllStandardDrafts() {
    const entries = Object.entries(get().standardDraft)
    if (entries.length === 0) return 0
    let count = 0
    for (const [pointId, draft] of entries) {
      if (!get().points.some((point) => point.id === pointId)) continue
      const min = Math.min(draft.standardMin, draft.standardMax)
      const max = Math.max(draft.standardMin, draft.standardMax)
      await commitStandardVersion(pointId, {
        standardMin: min,
        standardMax: max > min ? max : min + 0.001,
        isCritical: draft.isCritical,
        effectiveDate: draft.effectiveDate || todayText()
      })
      count += 1
    }
    get().clearStandardDraft()
    return count
  },

  devicesOfStation(stationId) {
    return get().devices.filter((device) => device.stationId === stationId)
  },

  pointsOfDevice(deviceId) {
    return get().points.filter((point) => point.deviceId === deviceId)
  },

  versionsOfPoint(pointId) {
    return sortVersions(get().standardVersions.filter((version) => version.pointId === pointId))
  },

  latestVersionOf(pointId) {
    const versions = get().versionsOfPoint(pointId)
    return versions.length > 0 ? versions[versions.length - 1] : null
  },

  matchVersion(pointId, date) {
    return matchStandardVersion(
      get().standardVersions.filter((version) => version.pointId === pointId),
      date
    )
  },

  versionById(id) {
    return get().standardVersions.find((version) => version.id === id) ?? null
  },

  currentStation() {
    return get().stations.find((station) => station.id === get().currentStationId) ?? null
  },

  filteredStations() {
    const { stations, filter } = get()
    const text = filter.keyword.trim().toLowerCase()
    return stations.filter((station) => {
      if (filter.grades.length > 0 && !filter.grades.includes(station.grade)) return false
      if (filter.deviceTypes.length > 0) {
        const has = get().devices.some(
          (device) => device.stationId === station.id && filter.deviceTypes.includes(device.type)
        )
        if (!has) return false
      }
      if (text.length === 0) return true
      return station.name.toLowerCase().includes(text) || station.location.toLowerCase().includes(text)
    })
  },

  pointStats() {
    const points = get().points
    return { total: points.length, critical: points.filter((point) => point.isCritical).length }
  }
}))

liveQuery(async () => (await db.stations.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))).subscribe({
  next: (rows) => useStationStore.setState({ stations: rows, ready: true }),
  error: () => useStationStore.setState({ ready: true })
})

liveQuery(async () => (await db.devices.toArray()).sort((a, b) => a.serialNo.localeCompare(b.serialNo))).subscribe({
  next: (rows) => useStationStore.setState({ devices: rows })
})

liveQuery(async () =>
  (await db.points.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
).subscribe({
  next: (rows) => useStationStore.setState({ points: rows })
})

liveQuery(async () =>
  (await db.standardVersions.toArray()).sort(
    (a: StandardVersionRow, b: StandardVersionRow) =>
      a.pointId.localeCompare(b.pointId) || a.version - b.version
  )
).subscribe({
  next: (rows) => useStationStore.setState({ standardVersions: rows })
})

export type { DeviceState, DeviceType }
