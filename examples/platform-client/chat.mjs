// Ứng dụng mẫu dùng Platform API (M17). Node.js 20+, không cần thư viện ngoài.
//
//   UNIAI_API_URL=https://uniai-api-staging-….run.app \
//   UNIAI_APP_KEY=uak_… \
//   node examples/platform-client/chat.mjs "Tóm tắt quy chế học vụ trong 3 ý" [--stream]
//
// Key đọc từ biến môi trường (hoặc kho bí mật của ứng dụng) – không ghi vào mã nguồn.

const API_URL = process.env.UNIAI_API_URL?.replace(/\/+$/, '');
const KEY = process.env.UNIAI_APP_KEY;
if (!API_URL || !KEY) {
  console.error('Cần đặt UNIAI_API_URL và UNIAI_APP_KEY.');
  process.exit(2);
}

const args = process.argv.slice(2);
const stream = args.includes('--stream');
const question = args.filter((a) => a !== '--stream').join(' ') || 'Xin chào, bạn là ai?';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const usd = (micro) => `$${(micro / 1_000_000).toFixed(4)}`;

async function failIfNotOk(res) {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  const retry = res.headers.get('retry-after');
  throw new Error(
    `HTTP ${res.status}: ${body.message ?? res.statusText}${retry ? ` (thử lại sau ${retry} giây)` : ''}`,
  );
}

const request = {
  messages: [
    {
      role: 'system',
      content: 'Bạn là trợ lý AI của ứng dụng mẫu. Trả lời ngắn gọn bằng tiếng Việt.',
    },
    { role: 'user', content: question },
  ],
  model: 'auto',
  stream,
  reference: `sample:${Date.now()}`,
};

const res = await fetch(`${API_URL}/api/platform/v1/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify(request),
});
await failIfNotOk(res);

if (!stream) {
  const answer = await res.json();
  console.log(answer.output);
  console.log(
    `\n[${answer.model.displayName} – ${answer.routeReason}] chi phí ${usd(answer.cost ?? 0)}, mã giao dịch ${answer.id}`,
  );
} else {
  // Server-Sent Events: "event: <type>\ndata: <JSON>\n\n"
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue; // ": ping" keep-alive
      const event = JSON.parse(line.slice(6));
      if (event.type === 'delta') process.stdout.write(event.text);
      else if (event.type === 'error') console.error(`\nLỗi: ${event.message}`);
      else if (event.type === 'done')
        console.log(`\n\n[chi phí ${usd(event.cost ?? 0)}, mã giao dịch ${event.id}]`);
    }
  }
}

const usage = await fetch(`${API_URL}/api/platform/v1/usage`, { headers });
if (usage.ok) {
  const u = await usage.json();
  console.log(`Tháng ${u.period}: đã dùng ${usd(u.used)} / ${usd(u.monthlyBudget)}`);
}
