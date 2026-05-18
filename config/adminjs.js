const path = require("path");
const { User, Card, Payment, AuditLog, PlatformProfit, Setting } = require("../models");
const { settlePaymentToSeller, refundPaymentByLookup } = require("../controllers/payment.controller");

const ADMIN_PANEL_EMAIL = process.env.ADMIN_PANEL_EMAIL || "admin@example.com";
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || "change-this-password";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "change-this-session-secret-to-at-least-32-characters";

async function setupAdminPanel(app) {
  const [
    { default: AdminJS, ComponentLoader },
    { default: AdminJSExpress },
    AdminJSSequelize,
  ] = await Promise.all([
    import("adminjs"),
    import("@adminjs/express"),
    import("@adminjs/sequelize"),
  ]);

  const componentLoader = new ComponentLoader();

  const Components = {
    Dashboard: componentLoader.add("Dashboard", path.join(__dirname, "..", "dashboard.jsx")),
  };

  AdminJS.registerAdapter(AdminJSSequelize);

  const admin = new AdminJS({
    rootPath: "/admin",
    branding: {
      companyName: "GitCard Crypto Admin",
      logo: "/admin_logo.png",
      softwareBrothers: false,
      theme: {
        colors: {
          primary100: "#0f172a",
          primary80: "#1e293b",
          primary60: "#334155",
          primary40: "#475569",
          primary20: "#64748b",
          accent: "#ea580c",
          hoverBg: "#f8fafc",
          bg: "#f1f5f9",
          white: "#ffffff",
          grey100: "#020617",
          grey80: "#0f172a",
          grey60: "#334155",
          grey40: "#64748b",
          grey20: "#cbd5e1",
          border: "#e2e8f0",
          error: "#ef4444",
          success: "#10b981",
          info: "#3b82f6",
        },
      },
    },
    componentLoader,
    dashboard: { 
      component: Components.Dashboard,
      handler: async (request, response, context) => {
        const totalUsers = await User.count();
        const totalCards = await Card.count();
        const totalPayments = await Payment.count();
        
        const profits = await PlatformProfit.findAll();
        const totalProfitEth = profits.reduce((sum, p) => sum + (p.admin_profit || 0), 0);
        
        return {
          totalUsers: totalUsers || 0,
          totalCards: totalCards || 0,
          totalPayments: totalPayments || 0,
          totalProfitEth: Number(totalProfitEth.toFixed(6)) || 0
        };
      }
    },
    resources: [
      {
        resource: User,
        options: {
          navigation: { name: "Marketplace Control", icon: "Settings" },
          listProperties: ["id", "email", "role"],
          editProperties: ["email", "role", "password"],
        },
      },
      {
        resource: Card,
        options: {
          navigation: { name: "Marketplace Control", icon: "Settings" },
          sort: {
            sortBy: 'id',
            direction: 'desc',
          },
          listProperties: ["id", "name", "price", "status", "retailer", "seller_id", "card_code", "file_path"],
          properties: {
            price: { label: "Price (ETH)" },
            seller_asking_price: { label: "Seller Asking Price (ETH)" },
            denomination: { isVisible: false },
          },
          showProperties: ["id", "name", "description", "price", "seller_asking_price", "status", "retailer", "seller_id", "card_code", "card_pin", "file_path", "platformChargePercentage", "sellerReceives", "buyerPays", "platformProfit", "isValid"],
          editProperties: ["name", "description", "price", "status", "retailer", "card_code", "card_pin", "platformChargePercentage"],
          actions: {
            approve: {
              actionType: "record",
              component: false,
              icon: "Checkmark",
              guard: "Are you sure you want to approve this card and make it active?",
              isVisible: ({ record }) => record.params.status === "pending_approval",
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                try {
                  await record.update({ status: "active" });
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: "Card approved and now active!", type: "success" },
                    redirectUrl: "/admin/resources/cards",
                  };
                } catch (error) {
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: `Approval failed: ${error.message}`, type: "error" },
                  };
                }
              },
            },
            reject: {
              actionType: "record",
              component: false,
              icon: "Close",
              guard: "Reject this card listing?",
              isVisible: ({ record }) => record.params.status === "pending_approval",
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                try {
                  await record.update({ status: "rejected" });
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: "Card listing rejected.", type: "error" },
                    redirectUrl: "/admin/resources/cards",
                  };
                } catch (error) {
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: `Rejection failed: ${error.message}`, type: "error" },
                  };
                }
              },
            },
            view_file: {
              actionType: "record",
              icon: "View",
              isVisible: ({ record }) => !!record.params.file_path,
              handler: async (request, response, context) => {
                const { record } = context;
                const path = record.params.file_path;
                return { redirectUrl: path.startsWith("http") ? path : `/${path}` };
              },
            },
          },
        },
      },
      {
        resource: Payment,
        options: {
          navigation: { name: "Marketplace Control", icon: "Settings" },
          listProperties: ["id", "external_id", "amount", "admin_profit", "seller_payout_amount", "asset", "status", "complaint_status", "profit_status", "card_id", "buyer_id", "release_at"],
          properties: {
            amount: { label: "Total Amount (ETH)" },
            seller_payout_amount: { label: "Seller Payout (ETH)" },
            admin_profit: { label: "Admin Profit (ETH)" },
            asset: { label: "Asset" },
            profit_status: { label: "Profit Status" },
            profit_locked_until: { label: "Profit Locked Until" },
            payout_tx_hash: { label: "Payout TX Hash" },
          },
          showProperties: ["id", "external_id", "amount", "seller_payout_amount", "admin_profit", "payout_tx_hash", "asset", "status", "complaint_status", "complaint_reason", "profit_status", "profit_locked_until", "card_id", "buyer_id", "release_at", "created_at"],
          actions: {
            new: { isAccessible: false },
            delete: { isAccessible: false },
            resolve_valid: {
              actionType: "record",
              component: false,
              icon: "Checkmark",
              label: "✓ Release Fund To Seller",
              guard: "Resolve complaint as invalid and release seller payout?",
              isVisible: ({ record }) => {
                const status = record.param('status');
                const complaintStatus = record.param('complaint_status');
                return (["disputed", "holding"].includes(status) && ["complained", "under_review"].includes(complaintStatus));
              },
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                try {
                  const paymentId = Number(record.param("id"));
                  const payment = await Payment.findByPk(paymentId);
                  if (!payment) throw new Error("Payment not found");
                  payment.complaint_status = "resolved";
                  await payment.save();
                  const settlement = await settlePaymentToSeller({ paymentId });
                  if (!settlement.didSettle && settlement.reason !== "Already settled.") throw new Error(settlement.reason || "Settlement failed");
                  payment.status = "completed";
                  await payment.save();
                  await AuditLog.create({
                    admin_email: currentAdmin.email,
                    action: "RELEASE_FUND_TO_SELLER",
                    target_type: "Payment",
                    target_id: paymentId,
                    details: `Dispute resolved as invalid. Funds released. TX: ${settlement.payoutTxHash || payment.payout_tx_hash || "N/A"}`,
                  });
                  await record.load();
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: `Funds released to seller. TX: ${settlement.payoutTxHash || payment.payout_tx_hash || "N/A"}`, type: "success" },
                    redirectUrl: "/admin/resources/payments",
                  };
                } catch (error) {
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: `Error: ${error.message}`, type: "error" },
                  };
                }
              },
            },
            refund: {
              actionType: "record",
              component: false,
              icon: "Undo",
              label: "↶ Refund Buyer",
              guard: "Refund this payment and cancel seller payout?",
              isVisible: ({ record }) => {
                const status = record.param('status');
                const complaintStatus = record.param('complaint_status');
                return (["disputed", "holding"].includes(status) && ["complained", "under_review"].includes(complaintStatus));
              },
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                try {
                  const paymentId = Number(record.param("id"));
                  const payment = await Payment.findByPk(paymentId);
                  if (!payment) throw new Error("Payment not found");
                  const { payment: refundedPayment, refundTxHash } = await refundPaymentByLookup({ paymentId });
                  refundedPayment.complaint_status = "refunded";
                  refundedPayment.status = "returned";
                  await refundedPayment.save();
                  await AuditLog.create({
                    admin_email: currentAdmin.email,
                    action: "REFUND_BUYER",
                    target_type: "Payment",
                    target_id: paymentId,
                    details: `Dispute resolved as valid. Buyer refunded. TX: ${refundTxHash}`,
                  });
                  await record.load();
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: `Buyer refunded successfully. TX: ${refundTxHash}`, type: "success" },
                    redirectUrl: "/admin/resources/payments",
                  };
                } catch (error) {
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: `Error: ${error.message}`, type: "error" },
                  };
                }
              },
            },
            view_card_file: {
              actionType: "record",
              icon: "View",
              isVisible: ({ record }) => !!record.params.card_id,
              handler: async (request, response, context) => {
                const { record } = context;
                const payment = await Payment.findByPk(record.params.id, { include: [{ model: Card, as: "card" }] });
                if (!payment || !payment.card || !payment.card.file_path) return { notice: { message: "No file found for this card.", type: "error" } };
                const path = payment.card.file_path;
                return { redirectUrl: path.startsWith("http") ? path : `/${path}` };
              },
            },
            mark_under_review: {
              actionType: "record",
              component: false,
              icon: "Search",
              label: "Mark Under Review",
              isVisible: ({ record }) => record.params.complaint_status === "complained",
              handler: async (request, _response, context) => {
                const { record, currentAdmin } = context;
                try {
                  await record.update({ complaint_status: "under_review" });
                  await AuditLog.create({
                    admin_email: currentAdmin.email,
                    action: "MARK_UNDER_REVIEW",
                    target_type: "Payment",
                    target_id: record.params.id,
                    details: `Dispute marked as under review by admin.`,
                  });
                  await record.load();
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: "Dispute is now under review.", type: "info" },
                    redirectUrl: "/admin/resources/payments",
                  };
                } catch (error) {
                  return { record: record.toJSON(currentAdmin), notice: { message: error.message, type: "error" } };
                }
              },
            },
          },
        },
      },
      {
        resource: AuditLog,
        options: {
          navigation: { name: "Marketplace Control", icon: "Settings" },
          listProperties: ["id", "admin_email", "action", "target_type", "target_id", "created_at"],
          actions: {
            new: { isVisible: false },
            edit: { isVisible: false },
            delete: { isVisible: false },
          },
        },
      },
      {
        resource: PlatformProfit,
        options: {
          navigation: { name: "Marketplace Control", icon: "Settings" },
          listProperties: ["id", "payment_id", "total_amount", "seller_payout", "admin_profit", "asset", "status", "locked_until", "created_at"],
          properties: {
            total_amount: { label: "Total Amount (ETH)" },
            seller_payout: { label: "Seller Payout (ETH)" },
            admin_profit: { label: "Admin Profit (ETH)" },
          },
          editProperties: ["status", "locked_until"],
        },
      },
      {
        resource: Setting,
        options: {
          navigation: { name: "Marketplace Control", icon: "Settings" },
          listProperties: ["id", "key", "value", "description"],
          editProperties: ["value", "description"],
        },
      },
    ],
  });

  const { componentsBundler, generateUserComponentEntry, ADMIN_JS_TMP_DIR } = await import("adminjs/bundler");
  await componentsBundler.createEntry({ content: generateUserComponentEntry(admin, ADMIN_JS_TMP_DIR) });
  await componentsBundler.build();

  if (process.env.NODE_ENV === "production") await admin.initialize();

  const adminRouter = AdminJSExpress.buildAuthenticatedRouter(
    admin,
    {
      authenticate: async (email, password) => (email === ADMIN_PANEL_EMAIL && password === ADMIN_PANEL_PASSWORD ? { email } : null),
      cookieName: "adminjs_session",
      cookiePassword: ADMIN_SESSION_SECRET,
    },
    null,
    { secret: ADMIN_SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 } },
  );

  app.use(admin.options.rootPath, adminRouter);
}

module.exports = setupAdminPanel;
