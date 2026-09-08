import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import Login from "./components/Login";
import ProtectedRoute from "./components/ProtectedRoute";
import OfficeLayout from "./components/layout/OfficeLayout";
import { SkeletonRows } from "./components/ui/Skeleton";
import { isAuthenticated, getUser, removeToken } from "./utils/auth";
import { canLoginOffice, homePathForRole } from "./utils/roles";
import CurrencySettings from "./pages/CurrencySettings";
import "./App.css";

const DailyReport = lazy(() => import("./pages/DailyReport"));
const ProductManagement = lazy(() => import("./pages/ProductManagement"));
const ProductOrganization = lazy(() => import("./pages/ProductOrganization"));
const ProductDashboard = lazy(() => import("./pages/ProductDashboard"));
const UserManagement = lazy(() => import("./pages/UserManagement"));
const SupplierFinance = lazy(() => import("./pages/SupplierFinance"));
const ShiftAudit = lazy(() => import("./pages/ShiftAudit"));
const RefundsPage = lazy(() => import("./pages/RefundsPage"));
const RefundApprovals = lazy(() => import("./pages/RefundApprovals"));
const OnAccountApprovals = lazy(() => import("./pages/OnAccountApprovals"));
const AdvanceApprovals = lazy(() => import("./pages/AdvanceApprovals"));
const StoreSettings = lazy(() => import("./pages/StoreSettings"));
const AccountantPermissions = lazy(() => import("./pages/AccountantPermissions"));
const Inventory = lazy(() => import("./pages/Inventory"));
const BakerySupplies = lazy(() => import("./pages/BakerySupplies"));
const ExpiryReports = lazy(() => import("./pages/ExpiryReports"));
const SalesByPrice = lazy(() => import("./pages/SalesByPrice"));
const CustomerManagement = lazy(() => import("./pages/CustomerManagement"));
const SupplierManagement = lazy(() => import("./pages/SupplierManagement"));
const SupplierStatement = lazy(() => import("./pages/SupplierStatement"));
const Purchases = lazy(() => import("./pages/Purchases"));
const SalesInvoices = lazy(() => import("./pages/SalesInvoices"));
const InventoryDocumentsList = lazy(() => import("./pages/inventoryDocuments/InventoryDocumentsList"));
const InventoryDocumentForm = lazy(() => import("./pages/inventoryDocuments/InventoryDocumentForm"));
const InventoryDocumentView = lazy(() => import("./pages/inventoryDocuments/InventoryDocumentView"));
const UnitsManagement = lazy(() => import("./pages/UnitsManagement"));
const CategoriesManagement = lazy(() => import("./pages/CategoriesManagement"));
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
const AttendanceKiosk = lazy(() => import("./pages/AttendanceKiosk"));

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
          path="/kiosk"
          element={
            <Suspense fallback={<PageFallback />}>
              <AttendanceKiosk />
            </Suspense>
          }
        />

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
              <OfficeRoute requirePermission="products">
                <ProductManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/product-organization"
            element={
              <OfficeRoute requirePermission="product_organization">
                <ProductOrganization />
              </OfficeRoute>
            }
          />
          <Route
            path="/products/:id"
            element={
              <OfficeRoute requirePermission="products">
                <ProductDashboard />
              </OfficeRoute>
            }
          />
          <Route
            path="/manage-users"
            element={
              <OfficeRoute requirePermission="user_accounts">
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
              <OfficeRoute requirePermission="store_settings">
                <StoreSettings />
              </OfficeRoute>
            }
          />
          <Route
            path="/settings/currency"
            element={
              <OfficeRoute requirePermission="currencies">
                <CurrencySettings />
              </OfficeRoute>
            }
          />
          <Route
            path="/permissions"
            element={
              <OfficeRoute requirePermission="permissions">
                <AccountantPermissions />
              </OfficeRoute>
            }
          />
          <Route
            path="/units"
            element={
              <OfficeRoute requirePermission="units">
                <UnitsManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/categories"
            element={
              <OfficeRoute requirePermission="categories">
                <CategoriesManagement />
              </OfficeRoute>
            }
          />
          <Route path="/unit-names" element={<Navigate to="/units" replace />} />
          <Route
            path="/inventory"
            element={
              <OfficeRoute requirePermission="stock_count">
                <Inventory />
              </OfficeRoute>
            }
          />
          <Route
            path="/bakery-supplies"
            element={
              <OfficeRoute requirePermission="bakery_supplies">
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
              <OfficeRoute requirePermission="customers">
                <CustomerManagement />
              </OfficeRoute>
            }
          />
          <Route
            path="/suppliers"
            element={
              <OfficeRoute requirePermission="suppliers">
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
              <OfficeRoute requirePermission="purchases">
                <Purchases />
              </OfficeRoute>
            }
          />
          <Route
            path="/sales-invoices"
            element={
              <OfficeRoute requirePermission="sales_invoices">
                <SalesInvoices />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory-receipts"
            element={
              <OfficeRoute requirePermission="inventory_receipts">
                <InventoryDocumentsList docType="receipt" />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory-receipts/new"
            element={
              <OfficeRoute requirePermission="inventory_receipts">
                <InventoryDocumentForm docType="receipt" />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory-receipts/:id"
            element={
              <OfficeRoute requirePermission="inventory_receipts">
                <InventoryDocumentView docType="receipt" />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory-issues"
            element={
              <OfficeRoute requirePermission="inventory_issues">
                <InventoryDocumentsList docType="issue" />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory-issues/new"
            element={
              <OfficeRoute requirePermission="inventory_issues">
                <InventoryDocumentForm docType="issue" />
              </OfficeRoute>
            }
          />
          <Route
            path="/inventory-issues/:id"
            element={
              <OfficeRoute requirePermission="inventory_issues">
                <InventoryDocumentView docType="issue" />
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
              <OfficeRoute requirePermission="marketing">
                <Marketing />
              </OfficeRoute>
            }
          />
          <Route
            path="/warehouses"
            element={
              <OfficeRoute requirePermission="warehouses">
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
