"use strict";

const { getToken, bcTask, sanitizeFilter, callAnthropic } = require("../shared/bcClient");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "https://dynamics.is",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const LANGUAGE_NAMES = { 1039: 'Icelandic', 1030: 'Danish', 1044: 'Norwegian' };

function buildSystemPrompt(lcid) {
  const lang = LANGUAGE_NAMES[lcid];
  const langInstruction = lang ? `\n\nIMPORTANT: The user has selected ${lang} as their language. Respond in ${lang} throughout this conversation.` : '';
  return SYSTEM_PROMPT_BASE + langInstruction;
}

const SYSTEM_PROMPT_BASE = `You are a Business Central sales order assistant for dynamics.is.
Your job is to help users create sales orders by understanding natural language requests and uploaded documents.

WORKFLOW:
1. Extract the customer and order lines from the user's message or uploaded document.
2. Use lookup_customer to find and confirm the correct BC customer. If multiple matches, list them and ask the user to confirm.
3. Use lookup_item for each product mentioned. The result has explicit fields: itemNo, description, baseUnitOfMeasure, unitPrice, salesUnitOfMeasure.
   - Use salesUnitOfMeasure as the UoM for the order line if non-empty; otherwise use baseUnitOfMeasure. Copy the exact string.
   - NEVER use a UoM code you did not receive from lookup_item or get_item_units_of_measure.
   - If the user mentions a unit that is neither baseUnitOfMeasure nor salesUnitOfMeasure, call get_item_units_of_measure first.
4. Use check_item_availability for each resolved item. Note any stock issues.
5. Use get_item_price for each item. Always pass customerNo and unitOfMeasureCode so the correct price tier is returned.
6. Once ALL lines and the customer are resolved to real BC records, call propose_sales_order.
7. Do NOT call propose_sales_order until you have confirmed: customerNo, and itemNo + unitPrice + unitOfMeasureCode for every line.

UNIT OF MEASURE RULES:
- lookup_item returns explicit fields: itemNo, description, baseUnitOfMeasure, unitPrice, salesUnitOfMeasure.
- NEVER invent or guess a UoM code (e.g. do NOT use 'PCS', 'EA', 'EACH' unless that exact string was returned by lookup_item or get_item_units_of_measure).
- Use salesUnitOfMeasure if non-empty, otherwise use baseUnitOfMeasure. Copy the value exactly as returned.
- Always set unitOfMeasureCode on every propose_sales_order line — never leave it blank.
- If Base UoM and Sales UoM differ, mention both to the user and confirm which one to use.
- Call get_item_units_of_measure when the user requests a specific UoM not yet known, or to show all options.
- Pass the chosen unitOfMeasureCode to get_item_price.

When propose_sales_order succeeds a draft order is created in BC immediately and real VAT totals are fetched. The user will see a confirmation panel. "__CONFIRM_ORDER__" finalises the existing draft — do not create a duplicate order.

TONE: Professional, concise. Use the currency shown in the statistics (defaults to ISK for Icelandic customers).
Always show prices excluding VAT in the line table, and summarise both excl. and incl. VAT in totals.
If a file was uploaded and no order intent was found, say so clearly and ask what the user would like to do.`;

const TOOLS = [
  {
    name: "lookup_customer",
    description: "Search for a customer in Business Central by name, number, or partial match. Returns top matches.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Customer name, number, or partial name to search" },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_item",
    description: "Search for an item/product in Business Central by item number or description. Returns objects with fields: itemNo, description, baseUnitOfMeasure, unitPrice, salesUnitOfMeasure. Always use salesUnitOfMeasure as the UoM if non-empty, otherwise baseUnitOfMeasure. Never invent a UoM code — only use what this tool returns.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Item number or description to search" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_item_units_of_measure",
    description: "Returns all units of measure defined for a specific item in the Item Unit of Measure table, including the Qty. per Unit of Measure. Call this when the user requests a UoM not already returned by lookup_item, or when you need to present all available UoM options to the user.",
    input_schema: {
      type: "object",
      properties: {
        itemNo: { type: "string", description: "Item number" },
      },
      required: ["itemNo"],
    },
  },
  {
    name: "check_item_availability",
    description: "Check stock availability for a specific item number.",
    input_schema: {
      type: "object",
      properties: {
        itemNo:                  { type: "string" },
        requestedDeliveryDate:   { type: "string", description: "ISO 8601 date, optional" },
      },
      required: ["itemNo"],
    },
  },
  {
    name: "get_item_price",
    description: "Get the sales price for an item, optionally for a specific customer and unit of measure. Always pass unitOfMeasureCode to ensure the correct UoM price tier is returned.",
    input_schema: {
      type: "object",
      properties: {
        itemNo:            { type: "string" },
        customerNo:        { type: "string", description: "Optional — customer number for customer-specific pricing" },
        quantity:          { type: "number", description: "Optional — quantity for volume pricing" },
        unitOfMeasureCode: { type: "string", description: "Optional — unit of measure code (e.g. 'PCS', 'BOX'). Pass the chosen UoM so the correct price tier is returned." },
      },
      required: ["itemNo"],
    },
  },
  {
    name: "check_customer_credit",
    description: "Check the credit limit and outstanding balance for a customer.",
    input_schema: {
      type: "object",
      properties: {
        customerNo: { type: "string" },
      },
      required: ["customerNo"],
    },
  },
  {
    name: "propose_sales_order",
    description: "Called when Claude has gathered enough information and is ready to show the user a draft order for confirmation. Do not call this until customer and all items are resolved to BC records.",
    input_schema: {
      type: "object",
      properties: {
        customerNo:              { type: "string" },
        customerName:            { type: "string" },
        requestedDeliveryDate:   { type: "string", description: "ISO 8601 date or null" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemNo:            { type: "string" },
              description:       { type: "string" },
              quantity:          { type: "number" },
              unitOfMeasureCode: { type: "string" },
              unitPrice:         { type: "number" },
              lineAmount:        { type: "number" },
              stockOk:           { type: "boolean" },
            },
            required: ["itemNo", "description", "quantity", "unitPrice"],
          },
        },
        notes: { type: "string", description: "Any special instructions from the user" },
      },
      required: ["customerNo", "customerName", "lines"],
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(name, input, tenantId, env, companyId, auth) {
  switch (name) {

    case "lookup_customer": {
      const q = sanitizeFilter(input.query);
      const CUST_FIELDS = [1, 2, 5, 7, 21, 22];
      const SEARCH_COLS = ["No.", "Name", "Address", "Post Code", "City", "Phone No.", "E-Mail"];

      // Multi-column search: query each field in parallel via Data.RecordIds.Get
      const idResults = await Promise.all(
        SEARCH_COLS.map(col =>
          bcTask(tenantId, env, companyId, auth, "Data.RecordIds.Get", "Customer", {
            tableView: `WHERE(Blocked=CONST( ),${col}=FILTER(@*${q}*))`,
            take: 50,
          }).catch(() => ({ result: [] }))
        )
      );

      // Collect unique SystemIds across all field queries
      const idSet = new Set();
      for (const r of idResults)
        for (const rec of (r.result || []))
          if (rec.id) idSet.add(rec.id);

      if (idSet.size === 0) return JSON.stringify([]);

      // Fetch full records for matched IDs
      const ids = [...idSet].slice(0, 20);
      const res = await bcTask(tenantId, env, companyId, auth, "Data.Records.Get", "Customer", {
        tableView: `WHERE(System Id=FILTER(${ids.join("|")}))`,
        fieldNumbers: CUST_FIELDS,
        take: ids.length,
      });
      return JSON.stringify(res.result || []);
    }

    case "lookup_item": {
      const q = sanitizeFilter(input.query);
      const ITEM_FIELDS = [1, 3, 8, 18, 47]; // No., Description, Base Unit of Measure, Unit Price, Sales Unit of Measure
      const SEARCH_COLS = ["No.", "Description", "Search Description"];

      const mapItems = (rows) => (rows || []).map(r => ({
        itemNo:              r.primaryKey?.["No_"] || "",
        description:         r.fields?.["Description"] || "",
        baseUnitOfMeasure:   r.fields?.["BaseUnitofMeasure"] || "",
        unitPrice:           r.fields?.["UnitPrice"] ?? 0,
        salesUnitOfMeasure:  r.fields?.["SalesUnitofMeasure"] || "",
      }));

      // Multi-column search: query each field in parallel via Data.RecordIds.Get
      const idResults = await Promise.all(
        SEARCH_COLS.map(col =>
          bcTask(tenantId, env, companyId, auth, "Data.RecordIds.Get", "Item", {
            tableView: `WHERE(Blocked=CONST(false),${col}=FILTER(@*${q}*))`,
            take: 50,
          }).catch(() => ({ result: [] }))
        )
      );

      // Collect unique SystemIds across all field queries
      const idSet = new Set();
      for (const r of idResults)
        for (const rec of (r.result || []))
          if (rec.id) idSet.add(rec.id);

      if (idSet.size === 0) return JSON.stringify([]);

      // Fetch full records for matched IDs
      const ids = [...idSet].slice(0, 20);
      const res = await bcTask(tenantId, env, companyId, auth, "Data.Records.Get", "Item", {
        tableView: `WHERE(System Id=FILTER(${ids.join("|")}))`,
        fieldNumbers: ITEM_FIELDS,
        take: ids.length,
      });
      return JSON.stringify(mapItems(res.result));
    }

    case "check_item_availability": {
      const data = {};
      if (input.requestedDeliveryDate) data.requestedDeliveryDate = input.requestedDeliveryDate;
      const res = await bcTask(tenantId, env, companyId, auth, "Item.Availability.Get", input.itemNo, Object.keys(data).length ? data : undefined);
      return JSON.stringify(res);
    }

    case "get_item_units_of_measure": {
      const res = await bcTask(tenantId, env, companyId, auth, "Data.Records.Get", "Item Unit of Measure", {
        tableView:    `WHERE(Item No.=FILTER(${sanitizeFilter(input.itemNo)}))`,
        fieldNumbers: [1, 2, 3], // Item No., Code, Qty. per Unit of Measure
        take:         50,
      });
      return JSON.stringify(res.result || []);
    }

    case "get_item_price": {
      const data = {};
      if (input.customerNo)        data.customerNo        = input.customerNo;
      if (input.quantity)          data.quantity          = input.quantity;
      if (input.unitOfMeasureCode) data.unitOfMeasureCode = input.unitOfMeasureCode;
      const res = await bcTask(tenantId, env, companyId, auth, "Item.Price.Get", input.itemNo, Object.keys(data).length ? data : undefined);
      return JSON.stringify(res);
    }

    case "check_customer_credit": {
      const res = await bcTask(tenantId, env, companyId, auth, "Customer.CreditLimit.Get", input.customerNo, undefined);
      return JSON.stringify(res);
    }

    // propose_sales_order is handled in the main loop — not reached here
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Create draft order + get real statistics from BC ───────────────────────────

async function createDraftAndGetStats(order, tenantId, env, companyId, auth) {
  // Step 1: create the Sales Header (draft/open)
  const orderNo = await createSalesOrder(order, tenantId, env, companyId, auth);

  // Step 2: call Sales.Order.Statistics to get real totals from BC
  const stats = await bcTask(tenantId, env, companyId, auth, "Sales.Order.Statistics", orderNo);

  return { orderNo, statistics: stats };
}

// ── Main agent loop ────────────────────────────────────────────────────────────

async function runAgentLoop(apiKey, messages, tenantId, env, companyId, auth, lcid) {
  let pendingOrder = null;
  const conversation = [...messages];

  // Trim conversation to prevent token overflow
  while (conversation.length > 40) conversation.shift();

  for (let turn = 0; turn < 10; turn++) {
    const response = await callAnthropic(apiKey, {
      model:      "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system:     buildSystemPrompt(lcid),
      tools:      TOOLS,
      messages:   conversation,
    });

    const toolUseBlocks = (response.content || []).filter(b => b.type === "tool_use");

    // No tool use → final text response
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      const textBlock = (response.content || []).find(b => b.type === "text");
      return { reply: textBlock?.text || "", pendingOrder };
    }

    // Append assistant turn to conversation
    conversation.push({ role: "assistant", content: response.content });

    // Execute all tool calls and collect results
    const toolResults = [];
    for (const block of toolUseBlocks) {
      if (block.name === "propose_sales_order") {
        pendingOrder = block.input;
        // Create the draft order in BC immediately and get real statistics
        try {
          const { orderNo, statistics } = await createDraftAndGetStats(block.input, tenantId, env, companyId, auth);
          pendingOrder.orderNo = orderNo;
          pendingOrder.statistics = statistics;
          toolResults.push({
            type:        "tool_result",
            tool_use_id: block.id,
            content:     `Order draft ${orderNo} created in BC. Statistics: ${JSON.stringify(statistics.order || {})}`,
          });
        } catch (e) {
          toolResults.push({
            type:        "tool_result",
            tool_use_id: block.id,
            content:     `Error creating draft order: ${e.message}`,
            is_error:    true,
          });
          pendingOrder = null;
        }
      } else {
        try {
          const result = await executeTool(block.name, block.input, tenantId, env, companyId, auth);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        } catch (e) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
        }
      }
    }

    conversation.push({ role: "user", content: toolResults });

    // If we just proposed an order, stop the loop — frontend shows confirmation screen
    if (pendingOrder) {
      const textBlock = (response.content || []).find(b => b.type === "text");
      return { reply: textBlock?.text || "I've prepared the order. Please review and confirm.", pendingOrder };
    }
  }

  return { reply: "I reached the maximum number of reasoning steps. Please try a simpler request.", pendingOrder };
}

// ── Sales order creation ───────────────────────────────────────────────────────

async function createSalesOrder(pendingOrder, tenantId, env, companyId, auth) {
  // Step 1: create Sales Header with blank No_ — let BC number series assign
  const headerRes = await bcTask(tenantId, env, companyId, auth, "Data.Records.Set", "Sales Header", {
    data: [{
      primaryKey: { DocumentType: "Order", No_: "" },
      fields: {
        SelltoCustomerNo_:     pendingOrder.customerNo,
        OrderDate:             new Date().toISOString().split("T")[0],
        RequestedDeliveryDate: pendingOrder.requestedDeliveryDate || "",
        ExternalDocumentNo_:   pendingOrder.notes ? pendingOrder.notes.slice(0, 35) : "",
      },
    }],
  });

  const orderNo = headerRes.result?.[0]?.primaryKey?.No_;
  if (!orderNo) throw new Error("BC did not return an order number after creating the Sales Header.");

  // Step 2: create all Sales Lines in one batch
  const linesData = pendingOrder.lines.map((line, i) => ({
    primaryKey: { DocumentType: "Order", DocumentNo_: orderNo, LineNo_: (i + 1) * 10000 },
    fields: {
      Type:              "Item",
      No_:               line.itemNo,
      Quantity:          line.quantity,
      UnitofMeasureCode: line.unitOfMeasureCode || "",
      UnitPrice:         line.unitPrice,
    },
  }));
  await bcTask(tenantId, env, companyId, auth, "Data.Records.Set", "Sales Line", { data: linesData });

  return orderNo;
}

// ── Azure Function entry point ─────────────────────────────────────────────────

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: CORS_HEADERS, body: "" };
    return;
  }

  const body = req.body || {};
  const { messages, apiKey, bcConfig, pendingOrder, lcid } = body;

  if (!apiKey)    { context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "apiKey is required" }) }; return; }
  if (!messages)  { context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "messages array is required" }) }; return; }
  if (!bcConfig)  { context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "bcConfig is required" }) }; return; }

  const tenantId     = bcConfig.tenantId     || process.env.BC_TENANT_ID;
  const environment  = bcConfig.environment  || process.env.BC_ENVIRONMENT;
  const companyId    = bcConfig.companyId;
  const clientId     = bcConfig.clientId     || process.env.BC_CLIENT_ID;
  const clientSecret = bcConfig.clientSecret || process.env.BC_CLIENT_SECRET;
  if (!tenantId || !environment || !companyId || !clientId || !clientSecret) {
    context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "bcConfig must include companyId; tenantId/environment/clientId/clientSecret can be provided in bcConfig or via server environment variables" }) };
    return;
  }

  try {
    const auth = `Bearer ${await getToken(tenantId, clientId, clientSecret)}`;

    // __CONFIRM_ORDER__ special message — create the actual order
    const lastMsg = messages[messages.length - 1];
    const isConfirm = lastMsg?.role === "user" &&
      (lastMsg?.content === "__CONFIRM_ORDER__" ||
       (Array.isArray(lastMsg?.content) && lastMsg.content.some(b => b.text === "__CONFIRM_ORDER__")));

    if (isConfirm) {
      if (!pendingOrder) {
        context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "No pendingOrder provided with __CONFIRM_ORDER__" }) };
        return;
      }
      // Order was already created as draft during propose_sales_order — just return it
      const orderNo = pendingOrder.orderNo;
      if (!orderNo) {
        context.res = { status: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Draft order has no orderNo — it may not have been created" }) };
        return;
      }
      context.res = {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ reply: `Sales order **${orderNo}** has been created successfully in Business Central.`, orderNo }),
      };
      return;
    }

    // __CANCEL_ORDER__ — delete the draft order from BC
    const isCancel = lastMsg?.role === "user" &&
      (lastMsg?.content === "__CANCEL_ORDER__" ||
       (Array.isArray(lastMsg?.content) && lastMsg.content.some(b => b.text === "__CANCEL_ORDER__")));

    if (isCancel) {
      if (pendingOrder?.orderNo) {
        try {
          await bcTask(tenantId, environment, companyId, auth, "Data.Records.Set", "Sales Header", {
            mode: "delete",
            data: [{ primaryKey: { DocumentType: "Order", No_: pendingOrder.orderNo } }],
          });
        } catch (_) { /* best effort — order may already be gone */ }
      }
      context.res = {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ reply: "Order cancelled.", cancelled: true }),
      };
      return;
    }

    const { reply, pendingOrder: newPendingOrder } = await runAgentLoop(
      apiKey, messages, tenantId, environment, companyId, auth, lcid,
    );

    context.res = {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ reply, ...(newPendingOrder ? { pendingOrder: newPendingOrder } : {}) }),
    };
  } catch (e) {
    context.res = {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
