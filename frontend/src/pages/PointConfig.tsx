/**
 * /points 巡检点位与标准值配置
 * 维护点位上下限、单位与关键点标记，支持模板批量复制；标准值改动先进草稿，
 * 提交时按生效日期生成/覆盖标准版本，读数按实际巡检日期匹配版本判定。
 * 消费 Point、Device、StandardVersion；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<AbnormalTag>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ReadingRow } from '@/utils/db'
import {
  EMPTY_POINT_DRAFT,
  POINT_TEMPLATES,
  POINT_UNITS,
  type Point,
  type PointDraft,
  type PointTemplate,
  type StandardVersion
} from '@/types/point'
import { DEVICE_TYPES } from '@/types/device'
import { abnormalLevelOf, deviationPctOf, rangeText } from '@/utils/range'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const todayStr = (): string => new Date().toISOString().slice(0, 10)

type PointFormValues = PointDraft & { standardEffectiveDate?: string }

export default function PointConfig() {
  const stationStore = useStationStore()
  const readingTable = useIdbTable<ReadingRow>(db.readings, { sortByUpdatedAt: false })

  const [pointForm] = Form.useForm<PointFormValues>()
  const [templateForm] = Form.useForm<{ deviceId: string }>()
  const [pointOpen, setPointOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checkedTemplates, setCheckedTemplates] = useState<string[]>(POINT_TEMPLATES.map((item) => item.name))
  /** 本次草稿提交统一使用的生效日期与调整原因 */
  const [effectiveDate, setEffectiveDate] = useState<string>(todayStr)
  const [reason, setReason] = useState('')
  const [historyPoint, setHistoryPoint] = useState<Point | null>(null)

  const filter = stationStore.pointFilter
  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'deviceTypes', label: '设备类型', options: DEVICE_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword: filter.keyword,
    stationId: filter.stationId,
    deviceTypes: filter.deviceTypes
  }

  const onModelChange = (next: FilterModel): void => {
    stationStore.patchPointFilter({
      keyword: String(next.keyword ?? ''),
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      deviceTypes: (Array.isArray(next.deviceTypes) ? next.deviceTypes : []) as string[]
    })
  }

  const rows = stationStore.points.filter((point) => {
    if (filter.stationId && point.stationId !== filter.stationId) return false
    if (filter.onlyCritical && !point.isCritical) return false
    if (filter.deviceTypes.length > 0) {
      const device = stationStore.devices.find((item) => item.id === point.deviceId)
      if (!device || !filter.deviceTypes.includes(device.type)) return false
    }
    const text = filter.keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === point.deviceId)
    return point.name.toLowerCase().includes(text) || (device ? device.model.toLowerCase().includes(text) : false)
  })

  const abnormalCountOf = (pointId: string): number =>
    readingTable.rows.filter((row) => row.pointId === pointId && row.isAbnormal).length

  /** 校验页头生效日期，不合法时提示并返回 false */
  const ensureEffectiveDate = (): boolean => {
    if (DATE_PATTERN.test(effectiveDate)) return true
    Message.warning('请先在页头填写合法的生效日期（YYYY-MM-DD）')
    return false
  }

  const deviceOptions = stationStore.devices
    .filter((device) => !filter.stationId || device.stationId === filter.stationId)
    .map((device) => {
      const station = stationStore.stations.find((item) => item.id === device.stationId)
      return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
    })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先在调压站台账登记设备')
      return
    }
    setEditingId(null)
    pointForm.setFieldsValue({ ...EMPTY_POINT_DRAFT, deviceId: deviceOptions[0].value, standardEffectiveDate: todayStr() })
    setPointOpen(true)
  }

  const openEdit = (point: Point): void => {
    setEditingId(point.id)
    pointForm.setFieldsValue({
      deviceId: point.deviceId,
      name: point.name,
      standardMin: point.standardMin,
      standardMax: point.standardMax,
      unit: point.unit,
      isCritical: point.isCritical,
      standardEffectiveDate: todayStr()
    })
    setPointOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await pointForm.validate().catch(() => null)
    if (!values) return
    const payload: PointDraft = {
      ...values,
      standardMin: Math.min(values.standardMin, values.standardMax),
      standardMax: Math.max(values.standardMin, values.standardMax)
    }
    if (editingId) {
      const point = stationStore.points.find((item) => item.id === editingId) ?? null
      await stationStore.updatePoint(editingId, { deviceId: payload.deviceId, name: payload.name, unit: payload.unit })
      const standardChanged =
        point !== null &&
        (point.standardMin !== payload.standardMin ||
          point.standardMax !== payload.standardMax ||
          point.isCritical !== payload.isCritical)
      if (standardChanged) {
        const date =
          values.standardEffectiveDate && DATE_PATTERN.test(values.standardEffectiveDate)
            ? values.standardEffectiveDate
            : todayStr()
        const result = await stationStore.commitStandardValues(
          editingId,
          { standardMin: payload.standardMin, standardMax: payload.standardMax, isCritical: payload.isCritical },
          date,
          '点位编辑调整'
        )
        Message.success(
          result.overwritten
            ? `点位已更新，标准值覆盖同日版本 v${result.row.version}（${date} 起生效）`
            : `点位已更新，标准值存为新版本 v${result.row.version}（${date} 起生效）`
        )
      } else {
        Message.success('点位已更新')
      }
    } else {
      await stationStore.createPoint(payload)
      Message.success('点位已创建，初始标准记为 v1')
    }
    setPointOpen(false)
  }

  const remove = async (point: Point): Promise<void> => {
    await stationStore.removePoint(point.id)
    Message.success('点位及其读数已删除')
  }

  const commitAll = async (): Promise<void> => {
    if (!ensureEffectiveDate()) return
    const { count, overwritten } = await stationStore.commitAllStandardDrafts(effectiveDate, reason)
    if (count === 0) {
      Message.warning('没有待提交的标准值草稿')
      return
    }
    Message.success(
      `已提交 ${count} 个点位标准值（${effectiveDate} 起生效）` +
        `${overwritten > 0 ? `，其中 ${overwritten} 个覆盖同日版本` : ''}；历史读数按巡检日期匹配版本判定`
    )
  }

  const openTemplate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    templateForm.setFieldsValue({ deviceId: deviceOptions[0].value })
    setCheckedTemplates(POINT_TEMPLATES.map((item) => item.name))
    setTemplateOpen(true)
  }

  const submitTemplate = async (): Promise<void> => {
    const values = await templateForm.validate().catch(() => null)
    if (!values) return
    const chosen: PointTemplate[] = POINT_TEMPLATES.filter((item) => checkedTemplates.includes(item.name))
    if (chosen.length === 0) {
      Message.warning('请至少选择一个模板点位')
      return
    }
    const created = await stationStore.applyTemplate(values.deviceId, chosen)
    Message.success(created === 0 ? '所选模板点位均已存在' : `已按模板复制 ${created} 个点位`)
    setTemplateOpen(false)
  }

  const columns: TableColumnProps<Point>[] = [
    { title: '点位名', dataIndex: 'name', width: 140, render: (value: string) => <strong>{value}</strong> },
    {
      title: '调压站 / 设备',
      width: 220,
      render: (_value, record) => {
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '标准区间（可编辑）',
      width: 330,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const min = draft ? draft.standardMin : record.standardMin
        const max = draft ? draft.standardMax : record.standardMax
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Space size={4}>
            <InputNumber
              size="small"
              style={{ width: 92 }}
              value={min}
              step={0.01}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
                  standardMin: Number(value ?? 0),
                  standardMax: max,
                  isCritical: critical
                })
              }
            />
            <span>~</span>
            <InputNumber
              size="small"
              style={{ width: 92 }}
              value={max}
              step={0.01}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
                  standardMin: min,
                  standardMax: Number(value ?? 0),
                  isCritical: critical
                })
              }
            />
            <span className="muted">{record.unit}</span>
            <Button
              type="text"
              size="small"
              disabled={!draft}
              onClick={async () => {
                if (!ensureEffectiveDate()) return
                const result = await stationStore.commitStandardDraft(record.id, effectiveDate, reason)
                if (!result) return
                Message.success(
                  result.overwritten
                    ? `${record.name} 标准值已覆盖同日版本 v${result.row.version}（${effectiveDate} 起生效）`
                    : `${record.name} 标准值已存为新版本 v${result.row.version}（${effectiveDate} 起生效）`
                )
              }}
            >
              保存
            </Button>
          </Space>
        )
      }
    },
    {
      title: '关键点',
      width: 110,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Switch
            size="small"
            checked={critical}
            onChange={(checked: boolean) =>
              stationStore.setStandardDraft(record.id, {
                standardMin: draft ? draft.standardMin : record.standardMin,
                standardMax: draft ? draft.standardMax : record.standardMax,
                isCritical: checked
              })
            }
          />
        )
      }
    },
    {
      title: '当前生效标准',
      width: 210,
      render: (_value, record) => {
        const version = stationStore.currentVersionOf(record.id)
        const min = version ? version.standardMin : record.standardMin
        const max = version ? version.standardMax : record.standardMax
        return (
          <Space size={4}>
            <span>{rangeText(min, max, record.unit)}</span>
            {version ? (
              <Tag size="small" color="blue" title={`自 ${version.effectiveDate} 起生效`}>
                v{version.version}
              </Tag>
            ) : null}
          </Space>
        )
      }
    },
    {
      title: '异常读数',
      width: 170,
      render: (_value, record) => {
        const count = abnormalCountOf(record.id)
        if (count === 0) return <Tag color="green">无异常</Tag>
        const worstRow = readingTable.rows
          .filter((row) => row.pointId === record.id && row.isAbnormal)
          .reduce((top, row) => (row.deviationPct > top.deviationPct ? row : top))
        const version = stationStore.standardVersions.find((item) => item.id === worstRow.standardVersionId)
        const critical = version ? version.isCritical : record.isCritical
        return <AbnormalTag level={abnormalLevelOf(worstRow.deviationPct, critical)} deviationPct={worstRow.deviationPct} size="small" />
      }
    },
    {
      title: '操作',
      width: 200,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button type="text" size="small" onClick={() => setHistoryPoint(record)}>
            版本
          </Button>
          <Popconfirm title="删除该点位将同时删除其巡检读数与标准版本" onOk={() => remove(record)}>
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const stats = stationStore.pointStats()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检点位与标准值配置</h2>
          <p className="page-head__desc">
            标准值按生效日期版本化：改值自生效日起启用，读数按实际巡检日期匹配版本判定，旧巡检与已派发处置单的判据不回溯。
          </p>
        </div>
        <div className="page-head__actions">
          <Input
            style={{ width: 150 }}
            value={effectiveDate}
            placeholder="生效日期"
            onChange={(value: string) => setEffectiveDate(value)}
          />
          <Input
            style={{ width: 180 }}
            value={reason}
            placeholder="调整原因（如 夏季标准）"
            onChange={(value: string) => setReason(value)}
          />
          <Button onClick={openTemplate}>按模板批量复制</Button>
          <Button disabled={Object.keys(stationStore.standardDraft).length === 0} onClick={commitAll}>
            提交标准值草稿（{Object.keys(stationStore.standardDraft).length}）
          </Button>
          <Button type="primary" onClick={openCreate}>
            新增点位
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="点位总数" value={stats.total} suffix="个" tone="primary" />
        <StatBadge label="关键点" value={stats.critical} suffix="个" tone="warning" />
        <StatBadge label="设备数" value={stationStore.devices.length} suffix="台" tone="info" />
        <StatBadge
          label="异常读数占比"
          value={readingTable.rows.filter((row) => row.isAbnormal).length}
          percent={
            readingTable.rows.length === 0
              ? 0
              : Math.round((readingTable.rows.filter((row) => row.isAbnormal).length / readingTable.rows.length) * 100)
          }
          tone="danger"
        />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索点位名 / 设备型号"
        switchLabel="仅看关键点"
        switchValue={filter.onlyCritical}
        hasSwitch
        onModelChange={onModelChange}
        onSwitchChange={(value: boolean) => stationStore.patchPointFilter({ onlyCritical: value })}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            点位清单（{rows.length} / {stats.total}）
          </h3>
          <span className="muted">
            草稿按页头生效日期提交为新版本；同一生效日期重复提交以最后一次为准覆盖该版本
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的点位"
            description="先到调压站台账登记设备，再按模板批量复制或手工新增点位。"
            actionText="新增点位"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => stationStore.resetPointFilter()}
            compact
          />
        ) : (
          <Table<Point>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
          />
        )}
      </div>

      <Modal
        visible={pointOpen}
        title={editingId ? '编辑点位' : '新增点位'}
        onCancel={() => setPointOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={pointForm} layout="vertical" initialValues={EMPTY_POINT_DRAFT}>
          <Form.Item field="deviceId" label="所属设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="name" label="点位名" rules={[{ required: true, message: '请填写点位名' }]}>
            <Input placeholder="如 出口压力 / 阀体泄漏浓度" />
          </Form.Item>
          <Form.Item field="standardMin" label="标准下限" rules={[{ required: true, message: '请填写标准下限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="standardMax" label="标准上限" rules={[{ required: true, message: '请填写标准上限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="unit" label="单位" rules={[{ required: true, message: '请选择单位' }]}>
            <Select options={POINT_UNITS.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="isCritical" label="是否关键点" triggerPropName="checked">
            <Switch />
          </Form.Item>
          {editingId ? (
            <Form.Item
              field="standardEffectiveDate"
              label="标准生效日期（仅当标准值或关键点有改动时生效）"
              rules={[{ match: DATE_PATTERN, message: '格式应为 YYYY-MM-DD' }]}
            >
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        visible={historyPoint !== null}
        title={`标准版本历史 · ${historyPoint?.name ?? ''}`}
        onCancel={() => setHistoryPoint(null)}
        footer={null}
        unmountOnExit
        style={{ width: 760 }}
      >
        <Table<StandardVersion>
          rowKey="id"
          size="small"
          border
          data={historyPoint ? stationStore.versionsOfPoint(historyPoint.id) : []}
          pagination={false}
          columns={[
            {
              title: '版本',
              width: 70,
              render: (_value: unknown, record: StandardVersion) => <Tag color="blue">v{record.version}</Tag>
            },
            { title: '生效日期', dataIndex: 'effectiveDate', width: 110 },
            {
              title: '标准区间',
              width: 150,
              render: (_value: unknown, record: StandardVersion) =>
                rangeText(record.standardMin, record.standardMax, historyPoint?.unit ?? '')
            },
            {
              title: '关键点',
              width: 80,
              render: (_value: unknown, record: StandardVersion) => (record.isCritical ? '是' : '否')
            },
            {
              title: '状态',
              width: 90,
              render: (_value: unknown, record: StandardVersion) => {
                if (record.effectiveDate > todayStr()) return <Tag color="orange">未生效</Tag>
                const current = historyPoint ? stationStore.currentVersionOf(historyPoint.id) : null
                return current && current.id === record.id ? <Tag color="green">生效中</Tag> : <Tag>历史</Tag>
              }
            },
            {
              title: '调整原因',
              dataIndex: 'reason',
              render: (value: string) => value || '—'
            }
          ]}
        />
        <div className="muted" style={{ marginTop: 10 }}>
          读数按实际巡检日期匹配生效版本判定；同一生效日期重复提交会覆盖该版本而不新增版本号。
        </div>
      </Modal>

      <Modal
        visible={templateOpen}
        title="按模板批量复制标准值"
        onCancel={() => setTemplateOpen(false)}
        onOk={submitTemplate}
        okText="复制点位"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={templateForm} layout="vertical">
          <Form.Item field="deviceId" label="目标设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
        </Form>
        <div className="muted" style={{ marginBottom: 8 }}>
          已存在的同名点位会自动跳过：
        </div>
        <Checkbox.Group
          value={checkedTemplates}
          onChange={(values: string[]) => setCheckedTemplates(values)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {POINT_TEMPLATES.map((item) => (
            <Checkbox key={item.name} value={item.name}>
              {item.name}（{rangeText(item.standardMin, item.standardMax, item.unit)}
              {item.isCritical ? ' · 关键点' : ''}）
            </Checkbox>
          ))}
        </Checkbox.Group>
        <div className="muted" style={{ marginTop: 10 }}>
          当前读数平均偏差参考：{deviationPctOf(0.3, 0.18, 0.25).toFixed(2)}%（示例计算）
        </div>
      </Modal>
    </div>
  )
}
