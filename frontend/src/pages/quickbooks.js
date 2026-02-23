import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtDate } from "../utils/format.js";

export async function quickBooksPage(routeFn) {
  // Load status from backend
  let status;
  try {
    status = await api("/qbo/status");
  } catch (e) {
    console.error(e);
    status = null;
  }

  const connected = !!status?.connected;
  const last = status?.last_customers_sync || null;
  const lastTx = status?.last_transactions_sync || null;

  const lastBadge = !last
    ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-black/5">No runs yet</span>`
    : (last.success
        ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-green-100 text-green-800">Success</span>`
        : `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800">Failed</span>`);

  const lastTxBadge = !lastTx
    ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-black/5">No runs yet</span>`
    : (lastTx.success
        ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-green-100 text-green-800">Success</span>`
        : `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800">Failed</span>`);

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4">

      <!-- Connection -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">QuickBooks Connection</div>
            <div class="text-sm text-black/60">Status of your QBO production connection.</div>
          </div>
          <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}">
            ${connected ? "Connected" : "Not connected"}
          </span>
        </div>

        <div class="mt-4 rounded-2xl border border-black/5 bg-white/40 overflow-hidden">
          <div class="flex flex-wrap items-stretch divide-y sm:divide-y-0 sm:divide-x divide-black/5">
            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Realm ID</div>
              <div class="font-semibold mt-1 truncate">${status?.realm_id || "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Token expires</div>
              <div class="font-semibold mt-1 whitespace-nowrap">${status?.token_expires_at || "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Last customers sync</div>
              <div class="mt-1">${lastBadge}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Last transactions sync</div>
              <div class="mt-1">${lastTxBadge}</div>
            </div>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          <button id="qboConnectBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Connect / Reconnect</button>
        </div>

        <div id="qboConnectMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-2"></div>
      </div>

      <!-- Sync -->
      <div class="card p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Customers Sync</div>
            <div class="text-sm text-black/60">Sync customers from QuickBooks into your database.</div>
          </div>
          <button id="qboSyncBtn" class="btn-primary" ${connected ? "" : "disabled"}>Sync customers now</button>
        </div>

        <div class="mt-4 rounded-2xl border border-black/5 bg-white/40 overflow-hidden">
          <div class="flex flex-wrap items-stretch divide-y sm:divide-y-0 sm:divide-x divide-black/5">
            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Started</div>
              <div class="font-semibold mt-1">${last?.started_at ? fmtDate(last.started_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Finished</div>
              <div class="font-semibold mt-1">${last?.finished_at ? fmtDate(last.finished_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Fetched</div>
              <div class="font-semibold mt-1">${(last && typeof last.fetched_count !== "undefined") ? last.fetched_count : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Upserted</div>
              <div class="font-semibold mt-1">${(last && typeof last.upserted_count !== "undefined") ? last.upserted_count : "—"}</div>
            </div>
          </div>
        </div>

        <div id="qboSyncMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-3"></div>
      </div>

      <!-- Transactions Sync -->
      <div class="card p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Transactions Sync</div>
            <div class="text-sm text-black/60">Sync invoices, bills, purchases, etc. into qbo_transactions + qbo_transaction_lines.</div>
          </div>
          <button id="qboTxSyncBtn" class="btn-primary" ${connected ? "" : "disabled"}>Sync transactions now</button>
        </div>

        <div class="mt-4 rounded-2xl border border-black/5 bg-white/40 overflow-hidden">
          <div class="flex flex-wrap items-stretch divide-y sm:divide-y-0 sm:divide-x divide-black/5">
            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Started</div>
              <div class="font-semibold mt-1">${lastTx?.started_at ? fmtDate(lastTx.started_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Finished</div>
              <div class="font-semibold mt-1">${lastTx?.finished_at ? fmtDate(lastTx.finished_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Fetched</div>
              <div class="font-semibold mt-1">${(lastTx && typeof lastTx.fetched_count !== "undefined") ? lastTx.fetched_count : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Upserted</div>
              <div class="font-semibold mt-1">${(lastTx && typeof lastTx.upserted_count !== "undefined") ? lastTx.upserted_count : "—"}</div>
            </div>
          </div>
        </div>

        <div id="qboTxSyncMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-3"></div>
      </div>

    </div>
  `;

  setShell({
    title: "QuickBooks",
    subtitle: "Connection + manual sync controls.",
    bodyHtml,
    showLogout: true,
    routeFn
  });

  // Connect / Reconnect: get auth_url from backend and open it
  document.getElementById("qboConnectBtn").onclick = async () => {
    const msg = document.getElementById("qboConnectMsg");
    msg.textContent = "";
    try {
      const data = await api("/qbo/start");
      if (!data?.auth_url) throw new Error("Missing auth_url");
      window.open(data.auth_url, "_blank", "noopener,noreferrer");
      msg.textContent = "Opened QuickBooks authorization in a new tab.";
      msg.className = "text-sm text-green-700 min-h-[1.25rem] mt-2";
    } catch (e) {
      msg.textContent = "Failed to start QuickBooks auth (check backend logs).";
    }
  };

  // Sync button: blocking call, show loading state, then reload page to refresh status
  const syncBtn = document.getElementById("qboSyncBtn");
  syncBtn.onclick = async () => {
    const msg = document.getElementById("qboSyncMsg");
    msg.textContent = "";
    msg.className = "text-sm text-black/60 min-h-[1.25rem] mt-3";

    syncBtn.disabled = true;
    const original = syncBtn.textContent;
    syncBtn.textContent = "Syncing…";

    try {
      const result = await api("/qbo/sync/customers", { method: "POST" });
      msg.className = "text-sm text-green-700 min-h-[1.25rem] mt-3";
      msg.textContent = `Sync complete. Fetched ${result.customers_fetched}, upserted ${result.customers_upserted}.`;

      // reload status from server and rerender the page
      location.hash = "#/quickbooks";
      routeFn();

    } catch (e) {
      msg.className = "text-sm text-red-700 min-h-[1.25rem] mt-3";
      msg.textContent = "Sync failed. Check backend logs or status error details.";
      syncBtn.disabled = false;
      syncBtn.textContent = original;
    }
  };

  const txBtn = document.getElementById("qboTxSyncBtn");
  txBtn.onclick = async () => {
    const msg = document.getElementById("qboTxSyncMsg");
    msg.textContent = "";
    msg.className = "text-sm text-black/60 min-h-[1.25rem] mt-3";

    txBtn.disabled = true;
    const original = txBtn.textContent;
    txBtn.textContent = "Syncing…";

    try {
      const result = await api("/qbo/sync/transactions", { method: "POST" });
      msg.className = "text-sm text-green-700 min-h-[1.25rem] mt-3";
      msg.textContent = `Sync complete. Fetched ${result.fetched_total}, upserted ${result.transactions_upserted}, lines ${result.lines_upserted}.`;

      location.hash = "#/quickbooks";
      routeFn();
    } catch (e) {
      msg.className = "text-sm text-red-700 min-h-[1.25rem] mt-3";
      msg.textContent = "Transactions sync failed. Check backend logs or status error details.";
      txBtn.disabled = false;
      txBtn.textContent = original;
    }
  };
}