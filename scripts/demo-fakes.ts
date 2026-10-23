import { DEMO, demoInboundMails, demoWeclappData } from "../packages/testing/demo-data.ts";
import { startFakeGraph } from "../packages/testing/fake-graph.ts";
import { startFakeWeclapp } from "../packages/testing/fake-weclapp.ts";

/**
 * DEMO ONLY: local stand-ins for weclapp and Microsoft Graph with synthetic data.
 * The real adapters talk to these exactly as they would to the real services.
 */
export const DEMO_PORTS = { weclapp: 4011, graph: 4012 };

export async function startDemoFakes() {
  const weclapp = await startFakeWeclapp(demoWeclappData(), { token: DEMO.weclappToken, port: DEMO_PORTS.weclapp });
  const graph = await startFakeGraph({ mailbox: DEMO.mailbox, clientSecret: DEMO.graphSecret, port: DEMO_PORTS.graph });
  const conversations = new Map<string, string>();
  for (const mail of demoInboundMails()) {
    const conversationId = conversations.get(mail.subject) ?? `demo-conv-${mail.key}`;
    conversations.set(mail.subject, conversationId);
    graph.addInbound({ from: mail.from, fromName: mail.fromName, replyTo: mail.replyTo, subject: mail.subject, body: mail.body, conversationId, receivedAt: new Date(Date.now() - mail.hoursAgo * 3_600_000), id: `AAMk-demo-${mail.key}`, internetMessageId: `<demo-${mail.key}@demo-haendler.example.invalid>` });
  }
  return { weclapp, graph };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { weclapp, graph } = await startDemoFakes();
  console.log(`[demo] weclapp-Testdouble: ${weclapp.baseUrl}`);
  console.log(`[demo] Graph-Testdouble:   ${graph.graphBaseUrl} (Postfach ${graph.mailbox}, ${graph.messages.length} synthetische Mails)`);
  console.log(`[demo] Weitere synthetische Kundenmail einspielen: curl -X POST http://127.0.0.1:${DEMO_PORTS.graph}/demo/inbound -H "content-type: application/json" -d '{"from":"test@kunde.example.invalid","subject":"Bestellung #1002","body":"Wo bleibt mein Paket?"}'`);
}
