/** 标准版本：点位标准值的历次变更，按生效日期启用，历史版本保留可查 */
export interface StandardVersion {
  id: string
  pointId: string
  /** 版本号，从 1 起递增；同一生效日期重复提交会覆盖当次版本而非新增 */
  version: number
  standardMin: number
  standardMax: number
  isCritical: boolean
  /** 生效日期 YYYY-MM-DD：读数按实际巡检日期匹配生效版本判定 */
  effectiveDate: string
  createdAt: number
  updatedAt: number
}

/** 按版本号升序 */
export function sortVersions(versions: StandardVersion[]): StandardVersion[] {
  return [...versions].sort((a, b) => a.version - b.version)
}

/**
 * 按巡检实际日期匹配生效版本：
 * 取生效日期不晚于 date 的最新一版；早于所有生效日期时回退到最早一版（第一版兜底历史）。
 */
export function matchStandardVersion(versions: StandardVersion[], date: string): StandardVersion | null {
  if (versions.length === 0) return null
  const sorted = [...versions].sort(
    (a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.version - b.version
  )
  let hit: StandardVersion | null = null
  for (const version of sorted) {
    if (version.effectiveDate <= date) hit = version
    else break
  }
  return hit ?? sorted[0]
}

/** 版本标签，如 v1 / v2 */
export function versionLabel(version: StandardVersion | null | undefined): string {
  return version ? `v${version.version}` : '—'
}
