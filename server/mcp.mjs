import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export async function registerMcp(app, { auth, context, actions }) {
  app.post('/mcp', async (request, reply) => {
    reply.header('WWW-Authenticate', 'Bearer resource_metadata="/.well-known/oauth-protected-resource"');
    const ctx = await context(request);
    if (!ctx.bearer) return reply.code(401).send({ error: { code: 'BEARER_REQUIRED', message: 'Use a scoped brand bearer token.' } });
    const server = new McpServer({ name: 'avafem-brand-connect', version: '0.1.0' });
    const result = data => ({ content: [{ type: 'text', text: JSON.stringify({ data }) }], structuredContent: { data } });
    const run = handler => async input => {
      try { return result(await handler(input)); }
      catch (error) { return { content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code || 'OPERATION_FAILED', message: error.statusCode ? error.message : 'Operation failed. Check the integration or request details.' } }) }], isError: true }; }
    };
    const read = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true } }, run(handler));
    const write = (name, description, inputSchema, endpoint, handler) => server.registerTool(name, {
      description, inputSchema: { ...inputSchema, idempotencyKey: z.string().min(1).max(200) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, run(async input => {
      const { idempotencyKey, ...body } = input;
      const outcome = await auth.idempotent(ctx.brandId, endpoint, idempotencyKey, body, () => handler(body));
      if (outcome.error) throw Object.assign(new Error(outcome.error.message), { statusCode: outcome.statusCode, code: outcome.error.code });
      return outcome.data;
    }));
    read('list_awaiting_shipment', 'List your brand’s sandbox Bags awaiting shipment.', {}, () => actions.listBags(ctx, { status: 'awaiting_shipment' }));
    read('get_bag', 'Read one Bag belonging to the authenticated brand. No health or cycle data is exposed.', { id: z.string().min(1) }, input => actions.getBag(ctx, input));
    read('get_payout_summary', 'Read your brand’s simulated transfer and credit summary. This never moves money.', {}, () => actions.payouts(ctx));
    read('get_catalog_issues', 'Read validation issues and review status for your own catalog.', {}, async () => (await actions.listProducts(ctx)).map(p => ({ id: p.id, sku: p.sku, status: p.status, validationIssues: p.validationIssues })));
    read('onboard_brand', 'Read the authenticated brand’s catalog and integration readiness. Account creation stays in the owner dashboard.', {}, () => actions.listProducts(ctx));
    write('mark_shipped', 'Record tracking for one of your sandbox Bags.', { id: z.string(), shipment: z.object({ carrier: z.string(), trackingNumber: z.string(), trackingUrl: z.string().nullable().optional() }) }, 'mcp:mark_shipped', input => actions.shipment(ctx, input));
    write('update_inventory', 'Update stock for one of your own catalog SKUs.', { sku: z.string(), qty: z.number().int().min(0) }, 'mcp:update_inventory', input => actions.inventory(ctx, input));
    write('import_products', 'Queue up to 5,000 catalog rows for validation and human review.', { rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }, 'mcp:import_products', input => actions.importProducts(ctx, input));
    write('refund_order', 'Submit a full-Bag refund proposal. A human must approve it; this tool cannot issue a payment refund.', { id: z.string(), refund: z.object({ reason: z.string().min(3), amountCents: z.number().int().positive().optional() }) }, 'mcp:refund_order', input => actions.refund(ctx, input));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.get('/mcp', async (_request, reply) => reply.code(405).header('Allow','POST').send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use Streamable HTTP POST with a brand bearer token.' } }));
}
