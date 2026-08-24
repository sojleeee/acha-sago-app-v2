import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import ReportApp from "./ReportApp.jsx";
import "./index.css";

// 관리자 앱은 더 이상 존재하지 않습니다 — Firestore 저장을 없애면서
// 상태를 "보여줄" 데이터 자체가 사라졌기 때문입니다. (신고 즉시 이메일만 발송)
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<ReportApp />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
