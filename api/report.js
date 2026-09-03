// Vercel Serverless Function
// 신고 데이터를 어디에도 저장하지 않고, 요청을 받은 즉시 Brevo API로 이메일만 보내고 끝냅니다.
// (Firestore 등 DB 없음 — 이 함수의 메모리에 잠깐 있다가 응답과 함께 사라짐)

const SENDER_EMAIL = "taejongchoi3136@gmail.com"; // Brevo에 발신자로 인증된 이메일
const SENDER_NAME = "아차사고 발굴";

// 안전환경실(총괄) — 신고 결과와 상관없이 항상 받는 사람들 (안전관리자, 실장님)
// ⚠ 아직 이메일이 확정되지 않아 비워뒀어요. 채워 넣으면 바로 적용됩니다.
const SAFETY_HEAD_EMAILS = [
  "ctjzzang99@slc.or.kr", // 안전관리자 (기존 확정 주소)
  "ksk3075@slc.or.kr", // 실장님
];

// 부서별 담당자 이메일 매핑 — "조치 요청(부서 배정)" 신고일 때, 해당 부서 관리감독자·안전담당자에게 같이 발송됩니다.
// ⚠ 아직 실제 이메일 주소가 확정되지 않아 비워뒀어요. 확정되는 대로 큰따옴표 안에 채워 넣으면 바로 적용됩니다.
// (안전환경실은 위 SAFETY_HEAD_EMAILS로 항상 받으므로 여기 따로 안 넣어도 됩니다.)
const DEPT_EMAILS = {
  "감사실":     { manager: "mi544@slc.or.kr", safety: "" }, // manager: 관리감독자(부서장), safety: 안전담당자
  "안전환경실": { manager: "", safety: "" },
  "ESG전략실":  { manager: "heeddonk@slc.or.kr", safety: "" },
  "홍보비서실": { manager: "mjkim@slc.or.kr", safety: "" },
  "기획조정처": { manager: "alfs2030@slc.or.kr", safety: "" },
  "경영지원처": { manager: "rhythm@slc.or.kr", safety: "" },
  "매립시설처": { manager: "jong7004@slc.or.kr", safety: "" },
  "매립운영처": { manager: "hipcb@slc.or.kr", safety: "" },
  "물환경처":   { manager: "hong7002@slc.or.kr", safety: "" },
  "자원사업처": { manager: "zsjh@slc.or.kr", safety: "" },
  "탄소사업처": { manager: "jeje89@slc.or.kr", safety: "" },
  "에너지사업처": { manager: "yh1399@slc.or.kr", safety: "" },
  "지역상생처": { manager: "jhhan@slc.or.kr", safety: "" },
  "체육공원처": { manager: "yklee@slc.or.kr", safety: "" },
  "기술정보처": { manager: "lwk007@slc.or.kr", safety: "" },
  "연구분석처": { manager: "kmc6540@slc.or.kr", safety: "" },
};

const HAZARD_LABELS = {
  slip: "🚶 넘어짐·미끄러짐·걸림",
  fall: "🏗️ 낙하·비래",
  electric: "⚡ 전기",
  fire: "🔥 화재·폭발",
  machine: "🚜 기계·설비",
  vehicle: "🚗 차량·운반장비",
  chemical: "🧪 화학물질",
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

    const statusLabel = resultType === "immediate" ? "본인 조치 완료" : "타 부서 조치 요청";

    // 신원 정보(소속/이름/연락처) 포함 여부에 따라 표를 두 버전으로 만듦
    function buildRows({ includeIdentity }) {
      const rows = [];
      if (includeIdentity) {
        rows.push(["소속", report.dept]);
        rows.push(["신고자", report.reporterName]);
        rows.push(["연락처", report.phone]);
      }
      rows.push(["위험 유형", hazardLabel(report)]);
      rows.push(["발견 일시", fmtDateTime(report.occurredAt)]);
      rows.push(["발견 장소", report.location]);
      rows.push(["상황 설명", report.desc]);
      if (resultType === "deferred") rows.push(["요청 부서", assignedDept || "-"]);
      if (resultType === "immediate") rows.push(["조치 내용", actionDesc || "-"]);
      return rows;
    }

    function buildHtml(rows) {
      const rowsHtml = rows
        .map(
          ([label, value]) => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #E0E6D6;color:#77816E;font-size:13px;white-space:nowrap;">${escapeHtml(label)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #E0E6D6;color:#1F2A17;font-size:14px;">${escapeHtml(value)}</td>
          </tr>`
        )
        .join("");
      return `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
          <h2 style="color:#1F2A17;">아차사고 발굴 신고 — ${escapeHtml(statusLabel)}</h2>
          <table style="width:100%;border-collapse:collapse;margin-top:12px;">
            ${rowsHtml}
          </table>
        </div>`;
    }

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

    // 안전환경실은 신원 정보 포함, 부서(관리감독자·안전담당자)는 신원 정보 제외하고 발송
    const safetyRecipients = new Set(SAFETY_HEAD_EMAILS.filter(Boolean));
    const deptRecipients = new Set();
    if (resultType === "deferred") {
      const dept = DEPT_EMAILS[assignedDept];
      if (dept?.manager) deptRecipients.add(dept.manager);
      if (dept?.safety) deptRecipients.add(dept.safety);
    }
    // 혹시 같은 주소가 안전환경실에도 있고 부서에도 있으면, 신원 정보 포함된 쪽(안전환경실)만 받도록 정리
    for (const email of safetyRecipients) deptRecipients.delete(email);

    if (safetyRecipients.size === 0 && deptRecipients.size === 0) {
      console.error("수신자가 한 명도 설정되어 있지 않습니다. SAFETY_HEAD_EMAILS를 확인하세요.");
      res.status(500).json({ error: "수신자 설정이 되어 있지 않습니다. 관리자에게 문의하세요." });
      return;
    }

    function buildPayload(recipients, includeIdentity) {
      return {
        sender: { email: SENDER_EMAIL, name: SENDER_NAME },
        to: [...recipients].map((email) => ({ email })),
        subject: `[아차사고] ${statusLabel} - ${hazardLabel(report)}`,
        htmlContent: buildHtml(buildRows({ includeIdentity })),
        ...(attachment.length > 0 ? { attachment } : {}),
      };
    }

    async function sendWithRetry(payload) {
      let brevoRes = await sendToBrevo(apiKey, payload);
      // 재시도해도 소용없는 오류(예: 400 잘못된 요청, 401 인증 오류)는 바로 실패 처리하고,
      // 서버 쪽 일시적 오류(5xx)일 때만 1.5초 후 한 번 더 시도
      if (!brevoRes.ok && brevoRes.status >= 500) {
        await sleep(1500);
        brevoRes = await sendToBrevo(apiKey, payload);
      }
      return brevoRes;
    }

    const sendJobs = [];
    if (safetyRecipients.size > 0) sendJobs.push(sendWithRetry(buildPayload(safetyRecipients, true)));
    if (deptRecipients.size > 0) sendJobs.push(sendWithRetry(buildPayload(deptRecipients, false)));

    const results = await Promise.all(sendJobs);
    const failed = results.find((r) => !r.ok);
    if (failed) {
      const errText = await failed.text();
      console.error("Brevo 발송 실패(재시도 포함):", failed.status, errText);
      res.status(502).json({ error: "메일 발송에 실패했습니다." });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("report API 오류:", e);
    res.status(500).json({ error: "서버 오류가 발생했습니다." });
  }
}
