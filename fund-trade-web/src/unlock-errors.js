// Allowlisted messages only; never echo credentials, private rows, or exceptions.
export function unlockErrorMessage(error) {
  if (error?.code === 'DATA_UNAVAILABLE') return '本地数据读取失败，请确认表格已保存、网站服务正在运行后重试。';
  if (['snapshot-unavailable', 'snapshot-changing'].includes(error?.message)) return '数据正在更新，请稍后重新解锁。';
  if (error?.message === 'day-changed') return '日期已切换，请使用今天的访问密码重试。';
  return '未能解锁，请检查密码后重试。';
}
