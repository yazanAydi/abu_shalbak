import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./components/Login";
import ProtectedRoute from "./components/ProtectedRoute";
import { SkeletonRows } from "./components/ui/Skeleton";
import { isAuthenticated, getUser, removeToken } from "./utils/auth";
import { canLoginPos, homePathForRole } from "./utils/roles";
import "./App.css";

const loadCheckout = () => import("./pages/Checkout");
const Checkout = lazy(loadCheckout);
const MyRefundRequests = lazy(() => import("./pages/MyRefundRequests"));

// The till always lands on checkout, so start its chunk immediately rather than
// waiting for the post-login redirect. Splitting it out still helps: the login
// screen no longer waits for the checkout code to parse.
loadCheckout();

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
  if (!canLoginPos(u?.role)) {
    removeToken();
    return <Navigate to="/login?wrong_portal=1" replace />;
  }
  return <Navigate to={homePathForRole(u?.role)} replace />;
}

function App() {
  return (
    <div className="app-root">
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/checkout"
            element={
              <ProtectedRoute requirePos>
                <Checkout />
              </ProtectedRoute>
            }
          />
          <Route
            path="/my-refunds"
            element={
              <ProtectedRoute requirePos>
                <MyRefundRequests />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<AuthenticatedHomeRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}

export default App;
