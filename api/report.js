// Vercel Serverless Function
// 신고 데이터를 어디에도 저장하지 않고, 요청을 받은 즉시 Brevo API로 이메일만 보내고 끝냅니다.
// (Firestore 등 DB 없음 — 이 함수의 메모리에 잠깐 있다가 응답과 함께 사라짐)

const SENDER_EMAIL = "taejongchoi3136@gmail.com"; // Brevo에 발신자로 인증된 이메일
const SENDER_NAME = "아차사고 발굴";

// 지금은 부서 구분 없이 고정 수신자 한 명에게만 보냅니다.
// 나중에 부서별 수신자를 나누게 되면 이 부분을 매핑 테이블로 바꾸면 됩니다.
const FIXED_RECIPIENT = "ctjzzang99@slc.or.kr";

const HAZARD_LABELS = {
  slip: "🚶 넘어짐·미끄러짐·걸림",
  fall: "🏗️ 낙하·비래",
  electric: "⚡ 전기",
  fire: "🔥 화재·폭발",
  machine: "🚜 기계·설비",
  vehicle: "🚗 차량·운반장비",
  chemical: "🧪 화학물질",
  ppe: "🦺 보호구",
  env: "🚧 작업환경",
  etc: "📋 기타",
};

function hazardLabel(report) {
  if (report.hazard === "etc" && report.hazardLabel) return report.hazardLabel;
  return HAZARD_LABELS[report.hazard] || "위험 상황";
}

function fmtDateTime(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleString("ko-KR", {
      year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return v;
  }
}

// "data:image/jpeg;base64,XXXX" 형태의 dataURL에서 base64 본문만 추출
function extractBase64(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const idx = dataUrl.indexOf(",");
  if (idx === -1) return null;
  return dataUrl.slice(idx + 1);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendToBrevo(apiKey, payload) {
  return fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 허용됩니다." });
    return;
  }

  // 우리 앱(같은 도메인)에서 온 요청인지 가볍게 확인 — 완벽한 보안은 아니지만
  // 외부에서 이 주소로 스팸성 요청을 무작정 반복 전송하는 걸 어느 정도 막아줌
  const origin = req.headers.origin || req.headers.referer || "";
  const host = req.headers.host || "";
  if (host && origin && !origin.includes(host)) {
    res.status(403).json({ error: "허용되지 않은 요청입니다." });
    return;
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error("BREVO_API_KEY 환경변수가 설정되지 않았습니다.");
    res.status(500).json({ error: "서버 설정 오류" });
    return;
  }

  try {
    const body = req.body || {};
    const { report, resultType, assignedDept, actionDesc, actionPhoto } = body;

    if (!report || !report.reporterName || !report.location || !report.desc) {
      res.status(400).json({ error: "필수 항목이 누락되었습니다." });
      return;
    }
    if (resultType !== "immediate" && resultType !== "deferred") {
      res.status(400).json({ error: "resultType이 올바르지 않습니다." });
      return;
    }

    const statusLabel = resultType === "immediate" ? "즉시 조치 완료" : "조치 요청 (담당 부서 배정)";

    const rows = [
      ["소속", report.dept],
      ["신고자", report.reporterName],
      ["연락처", report.phone],
      ["위험 유형", hazardLabel(report)],
      ["발견 일시", fmtDateTime(report.occurredAt)],
      ["발견 장소", report.location],
      ["상황 설명", report.desc],
    ];
    if (resultType === "deferred") {
      rows.push(["요청 부서", assignedDept || "-"]);
    }
    if (resultType === "immediate") {
      rows.push(["조치 내용", actionDesc || "-"]);
    }

    const rowsHtml = rows
      .map(
        ([label, value]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #E0E6D6;color:#77816E;font-size:13px;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #E0E6D6;color:#1F2A17;font-size:14px;">${escapeHtml(value)}</td>
        </tr>`
      )
      .join("");

    const htmlContent = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2 style="color:#1F2A17;">아차사고 발굴 신고 — ${escapeHtml(statusLabel)}</h2>
        <table style="width:100%;border-collapse:collapse;margin-top:12px;">
          ${rowsHtml}
        </table>
      </div>`;

    const attachment = [];
    const reportPhotoB64 = extractBase64(report.photo);
    if (reportPhotoB64) {
      attachment.push({ content: reportPhotoB64, name: "발견_사진.jpg" });
    }
    if (resultType === "immediate") {
      const actionPhotoB64 = extractBase64(actionPhoto);
      if (actionPhotoB64) {
        attachment.push({ content: actionPhotoB64, name: "조치_사진.jpg" });
      }
    }

    const emailPayload = {
      sender: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: [{ email: FIXED_RECIPIENT }],
      subject: `[아차사고] ${statusLabel} - ${hazardLabel(report)}`,
      htmlContent,
      ...(attachment.length > 0 ? { attachment } : {}),
    };

    let brevoRes = await sendToBrevo(apiKey, emailPayload);
    if (!brevoRes.ok) {
      // 순간적인 오류일 수 있으니 2초 후 한 번만 더 시도
      await sleep(2000);
      brevoRes = await sendToBrevo(apiKey, emailPayload);
    }

    if (!brevoRes.ok) {
      const errText = await brevoRes.text();
      console.error("Brevo 발송 실패(재시도 포함):", brevoRes.status, errText);
      res.status(502).json({ error: "메일 발송에 실패했습니다." });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("report API 오류:", e);
    res.status(500).json({ error: "서버 오류가 발생했습니다." });
  }
}
