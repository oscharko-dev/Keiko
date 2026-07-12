export function appendQueuePage(root, items, itemRow, loadedLabel, hasNext) {
  const body = root.querySelector(".mq-table tbody");
  const caption = root.querySelector(".mq-table caption");
  const footer = root.querySelector(".mq-footer");
  if (body === null || caption === null || footer === null) return false;
  body.append(...items.map(itemRow));
  caption.textContent = `${body.children.length} ${loadedLabel}`;
  if (!hasNext) {
    const scroller = root.querySelector(".mq-table-wrap");
    footer.remove();
    scroller?.focus();
  }
  return true;
}

export function actionData(detail, action, controls) {
  const data = {
    action,
    expectedVersion: detail.version,
    expectedPayloadDigest: detail.payloadDigest,
    idempotencyKey: crypto.randomUUID().replaceAll("-", ""),
  };
  controls
    .flatMap((control) => [...control.querySelectorAll("input, select")])
    .forEach((control) => {
      if (control.name) data[control.name] = control.value;
    });
  if (data.reviewAt) data.reviewAt = new Date(data.reviewAt).toISOString();
  if (data.expiresAt) data.expiresAt = new Date(data.expiresAt).toISOString();
  return data;
}
