function formatUsage(usage) {
  const fields = [
    ['input_tokens', '输入'],
    ['cached_input_tokens', '缓存输入'],
    ['output_tokens', '输出']
  ];
  return fields.filter(([key]) => Number.isSafeInteger(usage?.[key]))
    .map(([key, label]) => `${label} ${usage[key]}`).join(' / ');
}

export function formatStatus(view) {
  const lines = [
    `message_id : ${view.id}`,
    `state      : ${view.state}`,
    `from -> to : ${view.from} -> ${view.to} (${view.channel})`,
    `session    : ${view.session || '-'}`,
    `elapsed    : ${view.elapsedMs != null ? `${Math.round(view.elapsedMs / 1000)}s` : '-'}`
  ];
  if (view.cwd) lines.push(`cwd        : ${view.cwd}`);
  if (view.originNotice) lines.push(`原对话通知 : ${view.originNotice}`);
  if (view.runTimeoutSec != null) lines.push(`run_timeout: ${view.runTimeoutSec}s`);
  if (view.deadlineAt) lines.push(`deadline   : ${view.deadlineAt}`);
  if (view.remainingMs != null) lines.push(`remaining  : ${Math.ceil(view.remainingMs / 1000)}s`);
  if (view.acceptance) lines.push(`交付结论: ${view.acceptance.outcome}`);
  for (const [key, label] of [
    ['usage', '本轮用量'], ['sessionUsage', '会话累计'], ['reportedUsage', '原始用量（归属未确认）']
  ]) {
    const usage = formatUsage(view[key]);
    if (usage) lines.push(`${label}: ${usage}`);
  }
  if (view.reply) lines.push('', `reply:\n${view.reply}`);
  if (view.error) lines.push('', `error (${view.errorCode || 'error'}): ${view.error}`);
  if (view.hint) lines.push(`hint: ${view.hint}`);
  const steps = view.completedSteps;
  if (steps) {
    lines.push('', '已记录的完成步骤:');
    if (steps.filePatchCount) {
      lines.push(`  已应用补丁 ${steps.filePatchCount} 次${steps.files.length ? `；最近涉及: ${steps.files.join(', ')}` : ''}`);
    }
    if (steps.commandCount) {
      lines.push(`  已结束命令 ${steps.commandCount} 条${steps.commandCount > steps.commands.length ? `（最近 ${steps.commands.length} 条）` : ''}:`);
      for (const { command, exitCode, failed } of steps.commands) {
        const result = exitCode == null ? (failed ? '失败，未返回退出码' : '未返回退出码') : `exit ${exitCode}`;
        lines.push(`  - [${result}] ${command || '命令未提供'}`);
      }
    }
  }
  const progress = (view.progress || []).filter(entry => !steps || !/^(文件修改完成|命令结束)/.test(entry.note));
  if (progress.length) {
    lines.push('', 'progress:');
    for (const entry of progress) lines.push(`  - ${entry.note}`);
  }
  return lines.join('\n');
}

function clip(value, limit) {
  const text = (value ?? '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || null;
}

export function receiptView(view) {
  const acceptance = view.acceptance;
  const fields = acceptance && Object.fromEntries(
    Object.entries({ user_summary: 240, blockers: 220, verification: 160, next_step: 100, changes: 120 })
      .filter(([field]) => Object.hasOwn(acceptance, field))
      .map(([field, limit]) => [field, clip(acceptance[field], limit)])
  );
  return {
    id: view.id,
    state: view.state,
    channel: view.channel,
    elapsedMs: view.elapsedMs,
    timedOut: view.timedOut,
    outcome: view.state === 'done' ? acceptance?.outcome ?? 'unknown' : null,
    ...(acceptance && { acceptance: fields }),
    replyPreview: acceptance ? null : clip(view.reply, 600),
    replyTruncated: acceptance
      ? Object.entries(fields).some(([field, value]) => (value ?? '') !== acceptance[field])
      : (view.reply?.trim().length ?? 0) > 600,
    errorCode: view.errorCode,
    error: clip(view.error, 300),
    hint: clip(view.hint, 180),
    ...(view.completedSteps && {
      filePatchCount: view.completedSteps.filePatchCount,
      commandCount: view.completedSteps.commandCount
    })
  };
}

export function formatReceipt(receipt) {
  const elapsed = receipt.elapsedMs == null ? '-' : `${Math.round(receipt.elapsedMs / 1000)}s`;
  const lines = [
    `message_id=${receipt.id} state=${receipt.state} elapsed=${elapsed} channel=${receipt.channel}`
  ];
  if (receipt.outcome) lines.push(`交付结论: ${receipt.outcome}`);
  if (receipt.acceptance) {
    for (const [field, label] of [
      ['user_summary', '给用户的答复'], ['blockers', '未验证或阻塞'], ['verification', '验证'],
      ['next_step', '下一步'], ['changes', '改动']
    ]) {
      const value = receipt.acceptance[field];
      if (value) lines.push(`${label}：${value}`);
    }
  }
  if (receipt.timedOut) lines.push('监听超时，后台任务未中断。');
  if (receipt.error) lines.push(`error (${receipt.errorCode || 'error'}): ${receipt.error}`);
  if (receipt.hint) lines.push(`提示: ${receipt.hint}`);
  if (receipt.filePatchCount != null || receipt.commandCount != null) {
    lines.push(`已记录: 补丁 ${receipt.filePatchCount || 0} 次，命令结束 ${receipt.commandCount || 0} 条`);
  }
  if (receipt.replyPreview) lines.push(receipt.replyPreview);
  if (receipt.replyTruncated) lines.push('回复已截短；需要全文时按 ID 调用 bus_wait。');
  return lines.join('\n');
}

export function formatInboxMessage(message, { summary = false, mcp = false } = {}) {
  if (message.terminalReceipt) {
    return summary
      ? formatReceipt(receiptView(message.terminalReceipt))
      : formatStatus({ ...message.terminalReceipt, progress: [] });
  }
  if (summary && message.replyTo) {
    return formatReceipt(receiptView({
      id: message.replyTo, state: 'done', channel: message.channel || 'default', elapsedMs: message.durationMs,
      reply: message.text, acceptance: message.acceptance
    }));
  }
  const meta = mcp
    ? `id=${message.id} from=${message.from} channel=${message.channel || 'default'} at=${message.createdAt}${message.replyTo ? ` replyTo=${message.replyTo}` : ''}`
    : `${message.id}  from=${message.from}  channel=${message.channel || 'default'}  ${message.createdAt}${message.replyTo ? `  replyTo=${message.replyTo}` : ''}`;
  const head = `--- ${meta}`;
  return `${head}\n${summary ? clip(message.text, 600) || '' : message.text}`;
}
