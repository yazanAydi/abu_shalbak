import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import Login from "./components/Login";
import ProtectedRoute from "./components/ProtectedRoute";
import OfficeLayout from "./components/layout/OfficeLayout";
import { SkeletonRows } from "./components/ui/Skeleton";
import { isAuthenticated, getUser, removeToken } from "./utils/auth";
import { canLoginOffice, homePathForRole } from "./utils/roles";
import "./App.css";

const DailyReport = lazy(() => import("./pages/DailyReport"));
const ProductManagement = lazy(() => import("./pages/ProductManagement"));
const ProductDashboard = lazy(() => import("./pages/ProductDashboard"));
const UserManagement = lazy(() => import("./pages/UserManagement"));
const SupplierFinance = lazy(() => import("./pages/SupplierFinance"));
const ShiftAudit = lazy(() => import("./pages/ShiftAudit"));
const RefundsPage = lazy(() => import("./pages/RefundsPage"));
const RefundApprovals = lazy(() => import("./pages/RefundApprovals"));
const OnAccountApprovals = lazy(() => import("./pages/OnAccountApprovals"));
const AdvanceApprovals = lazy(() => import("./pages/AdvanceApprovals"));
const StoreSettings = lazy(() => import("./pages/StoreSettings"));
const CurrencySettings = lazy(() => import("./pages/CurrencySettings"));
const Inventory = lazy(() => import("./pages/Inventory"));
const BakerySupplies = lazy(() => import("./pages/BakerySupplies"));
const ExpiryReports = lazy(() => import("./pages/ExpiryReports"));
const SalesByPrice = lazy(() => import("./pages/SalesByPrice"));
const CustomerManagement = lazy(() => import("./pages/CustomerManagement"));
const SupplierManagement = lazy(() => import("./pages/SupplierManagement"));
const SupplierStatement = lazy(() => import("./pages/SupplierStatement"));
const Purchases = lazy(() => import("./pages/Purchases"));
const SalesInvoices = lazy(() => import("./pages/SalesInvoices"));
const UnitsManagement = lazy(() => import("./pages/UnitsManagement"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Deliveries = lazy(() => import("./pages/Deliveries"));
const Marketing = lazy(() => import("./pages/Marketing"));
const Warehouses = lazy(() => import("./pages/Warehouses"));
const BanksChecks = lazy(() => import("./pages/BanksChecks"));
const VouchersPage = lazy(() => import("./pages/VouchersPage"));
const AccountStatement = lazy(() => import("./pages/AccountStatement"));
const SupplierBalanceImport = lazy(() => import("./pages/SupplierBalanceImport"));
const SalesReports = lazy(() => import("./pages/SalesReports"));
const CashierPayroll = lazy(() => import("./pages/CashierPayroll"));

function PageFallback() {
  return (
    <div className="ui-page-loading" aria-busy="true" aria-label="جاري التحميل">
      <SkeletonRows rows={8} cols={3} />
    </div>
  );
}

function AuthenticatedHomeRedirect() {
  if (!isAuthenticated()) return <Navigate to="/login" replace />;

  const u = getUser();

  if (!canLoginOffice(u?.role)) {
    removeToken();
    return <Navigate to="/login?wrong_portal=1" replace />;
  }

  return <Navigate to={homePathForRole(u?.role, u?.permissions)} replace />;
}

function OfficeRoute({ children, adminOnly, requirePermission }) {
  return (
    <ProtectedRoute adminOnly={adminOnly} requirePermission={requirePermission} requireOffice>
      <Suspense fallback={<PageFallback />}>{children}</Suspense>
    </ProtectedRoute>
  );
}

function App() {
  return (
    <div className="app-root">
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route
          element={
            <ProtectedRoute requireOffice>
              <OfficeLayout />
            </ProtectedRoute>
          }
        >
          <Route
            path="/reports"
            element={
              <OfficeRoute requirePermission="dashboard">
                <DailyReport />
              </OfficeRoute>
            }
          />
          <Route
            path="/manage-products"
            element={
              <OfficeRoute adminOnly>
                <ProductManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/products/:id"
            element={
              <OfficeRoute adminOnly>
                <ProductDashboard />
              </OfficeRoute>
            }
          />
          <Route
            path="/manage-users"
            element={
              <OfficeRoute adminOnly>
                <UserManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/finance"
            element={
              <OfficeRoute requirePermission="finance">
                <SupplierFinance />
              </OfficeRoute>
            }
          />
          <Route
            path="/sales-reports"
            element={
              <OfficeRoute requirePermission="sales_reports">
                <SalesReports />
              </OfficeRoute>
            }
          />
          <Route
            path="/shift-audit"
            element={
              <OfficeRoute requirePermission="shift_audit">
                <ShiftAudit />
              </OfficeRoute>
            }
          />
          <Route
            path="/cashier-payroll"
            element={
              <OfficeRoute requirePermission="employee_payroll">
                <CashierPayroll />
              </OfficeRoute>
            }
          />
          <Route
            path="/refunds"
            element={
              <OfficeRoute requirePermission="refunds">
                <RefundsPage />
              </OfficeRoute>
            }
          />
          <Route
            path="/refund-approvals"
            element={
              <OfficeRoute requirePermission="refund_approvals">
                <RefundApprovals />
              </OfficeRoute>
            }
          />
          <Route
            path="/on-account-approvals"
            element={
              <OfficeRoute requirePermission="on_account_approvals">
                <OnAccountApprovals />
              </OfficeRoute>
            }
          />
          <Route
            path="/advance-approvals"
            element={
              <OfficeRoute requirePermission="advance_approvals">
                <AdvanceApprovals />
              </OfficeRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <OfficeRoute adminOnly>
                <StoreSettings />
              </OfficeRoute>
            }
          />
          <Route
            path="/settings/currency"
            element={
              <OfficeRoute adminOnly>
                <CurrencySettings />
              </OfficeRoute>
            }
          />
          <Route
            path="/units"
            element={
              <OfficeRoute adminOnly>
                <UnitsManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory"
            element={
              <OfficeRoute adminOnly>
                <Inventory />
              </OfficeRoute>
            }
          />
          <Route
            path="/bakery-supplies"
            element={
              <OfficeRoute adminOnly>
                <BakerySupplies />
              </OfficeRoute>
            }
          />
          <Route
            path="/expiry"
            element={
              <OfficeRoute requirePermission="expiry">
                <ExpiryReports />
              </OfficeRoute>
            }
          />
          <Route
            path="/sales-by-price"
            element={
              <OfficeRoute requirePermission="sales_by_price">
                <SalesByPrice />
              </OfficeRoute>
            }
          />
          <Route
            path="/customers"
            element={
              <OfficeRoute adminOnly>
                <CustomerManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/suppliers"
            element={
              <OfficeRoute adminOnly>
                <SupplierManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/suppliers/:supplierId/statement"
            element={
              <OfficeRoute requirePermission="account_statement">
                <SupplierStatement />
              </OfficeRoute>
            }
          />
          <Route
            path="/purchases"
            element={
              <OfficeRoute adminOnly>
                <Purchases />
              </OfficeRoute>
            }
          />
          <Route
            path="/sales-invoices"
            element={
              <OfficeRoute adminOnly>
                <SalesInvoices />
              </OfficeRoute>
            }
          />
          <Route
            path="/expenses"
            element={
              <OfficeRoute requirePermission="expenses">
                <Expenses />
              </OfficeRoute>
            }
          />
          <Route
            path="/deliveries"
            element={
              <OfficeRoute requirePermission="deliveries">
                <Deliveries />
              </OfficeRoute>
            }
          />
          <Route
            path="/marketing"
            element={
              <OfficeRoute adminOnly>
                <Marketing />
              </OfficeRoute>
            }
          />
          <Route
            path="/warehouses"
            element={
              <OfficeRoute adminOnly>
                <Warehouses />
              </OfficeRoute>
            }
          />
          <Route
            path="/banks"
            element={
              <OfficeRoute requirePermission="banks">
                <BanksChecks />
              </OfficeRoute>
            }
          />
          <Route
            path="/account-statement"
            element={
              <OfficeRoute requirePermission="account_statement">
                <AccountStatement />
              </OfficeRoute>
            }
          />
          <Route
            path="/import-supplier-balances"
            element={
              <OfficeRoute adminOnly>
                <SupplierBalanceImport />
              </OfficeRoute>
            }
          />
          <Route
            path="/vouchers"
            element={<Navigate to="/vouchers/receipt" replace />}
          />
          <Route
            path="/vouchers/:type"
            element={
              <OfficeRoute requirePermission="vouchers">
                <VouchersPage />
              </OfficeRoute>
            }
          />
        </Route>

        <Route path="/checkout" element={<Navigate to="/reports" replace />} />
        <Route path="/" element={<AuthenticatedHomeRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

export default App;
