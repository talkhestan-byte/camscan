// فایل اولیه CamScan؛ منطق اصلی اسکن را با نسخه اصلی خود جایگزین کنید.
document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("scanButton");
  const status = document.getElementById("status");

  button?.addEventListener("click", () => {
    if (status) {
      status.textContent = "اتصال قابلیت اسکن در نسخه اصلی قرار می‌گیرد.";
    }
  });
});
