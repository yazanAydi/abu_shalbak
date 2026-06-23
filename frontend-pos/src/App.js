import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./components/Login";
import ProtectedRoute from "./components/ProtectedRoute";
import Checkout from "./pages/Checkout";
import MyRefundRequests from "./pages/MyRefundRequests";
import { isAuthenticated, getUser, removeToken } from "./utils/auth";
import { canLoginPos, homePathForRole } from "./utils/roles";
import "./App.css";

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
    </div>
  );
}

export default App;
