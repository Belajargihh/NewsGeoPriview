document.addEventListener("DOMContentLoaded", () => {
  // --- Configuration ---
  const API_BASE_URL = "";

  // --- DOM Elements ---
  const searchQuery = document.getElementById("search-query");
  const searchBtn = document.getElementById("search-btn");
  const searchResultsContainer = document.getElementById("search-results");
  const mainLoader = document.getElementById("loader");
  const paginationContainer = document.getElementById("pagination-container");

  // Highlight Elements
  const highlightLoader = document.getElementById("highlight-loader");
  const highlightContainer = document.getElementById("highlight-container");
  const highlightError = document.getElementById("highlight-error");
  const btnPrevHighlight = document.getElementById("btn-prev-highlight");
  const btnNextHighlight = document.getElementById("btn-next-highlight");
  const btnPrevHighlightMobile = document.getElementById(
    "btn-prev-highlight-mobile"
  );
  const btnNextHighlightMobile = document.getElementById(
    "btn-next-highlight-mobile"
  );
  const highlightPageIndicator = document.getElementById(
    "highlight-page-indicator"
  );
  const mobileNavContainer = document.getElementById("mobile-nav-container");

  // Modal Elements
  const modal = document.getElementById("analysis-modal");
  const closeModalBtn = document.getElementById("close-modal-btn");
  const modalBackdrop = document.getElementById("modal-backdrop");

  // Elements inside Modal
  const modalTitle = document.getElementById("modal-article-title");
  const modalLink = document.getElementById("modal-article-link");
  const modalLocationText = document.getElementById("modal-location-text");
  const reviewLoader = document.getElementById("review-loader");
  const reviewContent = document.getElementById("review-content");
  const blurOverlay = document.getElementById("blur-overlay");
  const mapLoadingOverlay = document.getElementById("map-loading-overlay");

  // Controls
  const premiumToggle = document.getElementById("premium-toggle");
  const premiumLabel = document.getElementById("premiumLabel");
  const capacityNumber = document.getElementById("capacity-number");
  const freeTierInfo = document.getElementById("free-tier-info");

  // State
  let searchCapacity = 3;
  let allArticles = [];
  let currentPage = 1;
  const itemsPerPage = 7;
  let map, currentMarker;

  // State untuk Highlight Carousel
  let highlightArticles = [];
  let currentHighlightIndex = 0;
  const itemsPerHighlightPage = 2;

  // --- Init Map ---
  try {
    map = L.map("map", { zoomControl: false }).setView([-2.5489, 118.0149], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
  } catch (e) {
    console.error("Leaflet map gagal diinisialisasi.", e);
  }

  // --- Event Listeners ---
  if (searchBtn) searchBtn.addEventListener("click", handleSearch);
  if (searchQuery)
    searchQuery.addEventListener("keypress", (e) => {
      if (e.key === "Enter") handleSearch();
    });

  // Highlight Navigation
  btnPrevHighlight.addEventListener("click", () => moveHighlight(-1));
  btnNextHighlight.addEventListener("click", () => moveHighlight(1));
  btnPrevHighlightMobile.addEventListener("click", () => moveHighlight(-1));
  btnNextHighlightMobile.addEventListener("click", () => moveHighlight(1));

  // Modal Controls
  if (closeModalBtn) closeModalBtn.addEventListener("click", closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  if (premiumToggle) {
    premiumToggle.addEventListener("change", () => {
      const isPremium = premiumToggle.checked;
      document.body.classList.toggle("premium-mode", isPremium);
      if (isPremium) {
        premiumLabel.textContent = "Premium Mode";
        if (blurOverlay) blurOverlay.style.display = "none";
        if (freeTierInfo) freeTierInfo.classList.add("hidden");
      } else {
        premiumLabel.textContent = "Standard Mode";
        if (freeTierInfo) freeTierInfo.classList.remove("hidden");
        if (reviewContent && reviewContent.innerHTML !== "") {
          if (blurOverlay) blurOverlay.style.display = "flex";
        }
      }
    });
  }

  // --- Load Highlights on Init ---
  loadHighlights();

  // --- Functions ---

  function closeModal() {
    modal.classList.add("hidden");
    document.body.style.overflow = "auto";
  }

  function openModal() {
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 200);
  }

  async function extractImagesFromURL(articleURL) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/extract-images`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: articleURL }),
      });

      if (!response.ok) return [];

      const data = await response.json();
      return data.images || [];
    } catch (err) {
      console.error("Gagal ekstrak gambar:", err);
      return [];
    }
  }

  async function loadHighlights() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Berita Terkini Indonesia" }),
      });

      highlightLoader.style.display = "none";

      if (!response.ok) throw new Error("Network response was not ok");
      const data = await response.json();

      if (data.artikel_terkait && data.artikel_terkait.length > 0) {
        highlightArticles = data.artikel_terkait.slice(0, 10);
        currentHighlightIndex = 0;

        highlightContainer.classList.remove("hidden");
        mobileNavContainer.classList.remove("hidden");

        renderHighlights();
      } else {
        highlightError.classList.remove("hidden");
        mobileNavContainer.classList.add("hidden");
      }
    } catch (error) {
      highlightLoader.style.display = "none";
      highlightError.classList.remove("hidden");
      mobileNavContainer.classList.add("hidden");
      console.error("Gagal memuat highlight:", error);
    }
  }

  function renderHighlights() {
    highlightContainer.innerHTML = "";
    const start = currentHighlightIndex * itemsPerHighlightPage;
    const end = start + itemsPerHighlightPage;
    const visibleArticles = highlightArticles.slice(start, end);

    visibleArticles.forEach((article) => {
      const card = document.createElement("div");
      card.className =
        "p-4 border border-gray-100 rounded-xl hover:bg-gray-50 hover:border-blue-200 cursor-pointer transition bg-white shadow-sm flex flex-col justify-between h-full";
      card.innerHTML = `
                      <div>
                          <div class="flex justify-between items-start mb-2">
                              <span class="text-xs font-semibold text-red-500 bg-red-50 px-2 py-1 rounded-full inline-block">Terkini</span>
                              <span class="text-[10px] text-gray-400">${article.sumber}</span>
                          </div>
                          <h4 class="font-bold text-gray-800 text-sm line-clamp-2 mb-1 leading-snug">${article.judul}</h4>
                      </div>
                      <div class="mt-3 text-xs text-blue-500 font-medium flex items-center">
                          Lihat Analisis 
                          <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                      </div>
                  `;
      card.addEventListener("click", () => {
        handleArticleClick(article.url, article.judul);
      });
      highlightContainer.appendChild(card);
    });

    updateHighlightButtons();
  }

  function moveHighlight(direction) {
    const maxIndex =
      Math.ceil(highlightArticles.length / itemsPerHighlightPage) - 1;
    let newIndex = currentHighlightIndex + direction;
    if (newIndex < 0) newIndex = 0;
    if (newIndex > maxIndex) newIndex = maxIndex;
    if (newIndex !== currentHighlightIndex) {
      currentHighlightIndex = newIndex;
      renderHighlights();
    }
  }

  function updateHighlightButtons() {
    const maxIndex =
      Math.ceil(highlightArticles.length / itemsPerHighlightPage) - 1;
    btnPrevHighlight.disabled = currentHighlightIndex === 0;
    btnNextHighlight.disabled = currentHighlightIndex === maxIndex;
    btnPrevHighlightMobile.disabled = currentHighlightIndex === 0;
    btnNextHighlightMobile.disabled = currentHighlightIndex === maxIndex;
    highlightPageIndicator.textContent = `Halaman ${
      currentHighlightIndex + 1
    } dari ${maxIndex + 1}`;
  }

  async function handleSearch() {
    const query = searchQuery.value;
    if (!query) {
      alert("Silakan masukkan topik pencarian.");
      return;
    }
    if (searchCapacity <= 0) {
      alert("Kapasitas pencarian harian Anda sudah habis.");
      return;
    }

    mainLoader.style.display = "block";
    searchResultsContainer.innerHTML = "";
    paginationContainer.innerHTML = "";
    searchBtn.disabled = true;
    searchBtn.textContent = "Mencari...";

    try {
      const response = await fetch(`${API_BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query }),
      });

      mainLoader.style.display = "none";
      searchBtn.disabled = false;
      searchBtn.textContent = "Cari";

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(
          errData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      allArticles = data.artikel_terkait;
      currentPage = 1;

      if (!allArticles || allArticles.length === 0) {
        searchResultsContainer.innerHTML =
          '<p style="color: var(--secondary);">Tidak ada berita ditemukan.</p>';
        return;
      }

      searchCapacity--;
      capacityNumber.textContent = searchCapacity;

      displayPage(1);
    } catch (error) {
      mainLoader.style.display = "none";
      searchBtn.disabled = false;
      searchBtn.textContent = "Cari";
      searchResultsContainer.innerHTML = `<p class="text-red-500">Gagal memuat berita: ${error.message}. Pastikan server berjalan.</p>`;
      console.error("Search error:", error);
    }
  }

  function displayPage(page) {
    currentPage = page;
    searchResultsContainer.innerHTML = "";
    const totalPages = Math.ceil(allArticles.length / itemsPerPage);

    if (totalPages === 0) return;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const paginatedArticles = allArticles.slice(startIndex, endIndex);

    paginatedArticles.forEach(async (article) => {
      const card = document.createElement("div");
      card.className =
        "bg-white p-5 border border-gray-200 rounded-xl shadow-sm hover:shadow-md hover:border-blue-300 cursor-pointer transition flex items-center group article-card";
      card.dataset.url = article.url;

      // --- Ambil gambar dari URL ---
      const images = await extractImagesFromURL(article.url);
      const thumbnail = images[0] || "default-news.jpg";

      card.innerHTML = `
        <img src="${thumbnail}" class="w-24 h-20 object-cover rounded-lg mr-4 border">
        <div class="flex-grow">
            <h4 class="font-bold text-lg text-gray-800 group-hover:text-blue-600 transition line-clamp-2">${article.judul}</h4>
            <div class="flex items-center mt-2 text-sm text-gray-500">
                <span class="font-medium text-blue-500 bg-blue-50 px-2 py-0.5 rounded text-xs">${article.sumber}</span>
                <span class="mx-2">•</span>
                <span>Klik untuk analisis</span>
            </div>
        </div>
    `;

      card.addEventListener("click", () => {
        handleArticleClick(article.url, article.judul);
      });
      searchResultsContainer.appendChild(card);
    });

    renderPagination(totalPages, page);
  }

  function renderPagination(totalPages, page) {
    paginationContainer.innerHTML = "";
    const createBtn = (
      text,
      targetPage,
      isActive = false,
      isDisabled = false
    ) => {
      const btn = document.createElement("button");
      btn.innerHTML = text;
      btn.className = `pagination-btn ${isActive ? "active" : ""}`;
      if (isDisabled) btn.disabled = true;
      else btn.addEventListener("click", () => displayPage(targetPage));
      return btn;
    };
    paginationContainer.appendChild(
      createBtn("&laquo;", page - 1, false, page === 1)
    );

    let start = Math.max(1, page - 2);
    let end = Math.min(totalPages, page + 2);
    if (start > 1) {
      paginationContainer.appendChild(createBtn(1, 1, 1 === page));
      if (start > 2) {
        const dots = document.createElement("span");
        dots.textContent = "...";
        dots.className = "px-2 text-gray-400";
        paginationContainer.appendChild(dots);
      }
    }
    for (let i = start; i <= end; i++) {
      paginationContainer.appendChild(createBtn(i, i, i === page));
    }
    if (end < totalPages) {
      if (end < totalPages - 1) {
        const dots = document.createElement("span");
        dots.textContent = "...";
        dots.className = "px-2 text-gray-400";
        paginationContainer.appendChild(dots);
      }
      paginationContainer.appendChild(
        createBtn(totalPages, totalPages, totalPages === page)
      );
    }
    paginationContainer.appendChild(
      createBtn("&raquo;", page + 1, false, page === totalPages)
    );
  }

  async function handleArticleClick(url, title) {
    openModal();

    reviewLoader.style.display = "flex";
    mapLoadingOverlay.style.display = "flex";
    reviewContent.innerHTML = "";
    modalTitle.textContent = title;
    modalLink.href = url;
    modalLocationText.textContent = "Menganalisis...";

    if (blurOverlay) blurOverlay.style.display = "none";

    map.setView([-2.5489, 118.0149], 5);
    if (currentMarker) map.removeLayer(currentMarker);

    try {
      const response = await fetch(`${API_BASE_URL}/api/analyze-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      });

      reviewLoader.style.display = "none";
      mapLoadingOverlay.style.display = "none";

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(
          errData.error || `HTTP error! status: ${response.status}`
        );
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      modalLocationText.textContent =
        data.lokasi_kejadian || "Tidak terdeteksi";
      const formattedReview = data.ringkasan_interaktif
        ? data.ringkasan_interaktif.replace(/\n/g, "<br/>")
        : "Ringkasan tidak tersedia.";
        reviewContent.innerHTML = `<p>${formattedReview}</p>`;
      const images = await extractImagesFromURL(url);

      let imgHtml = "";
      if (images.length > 0) {
        imgHtml = `
        <div class="mb-4">
            <img src="${images[0]}" class="w-full rounded-xl shadow">
        </div>
    `;
      }

      reviewContent.innerHTML = imgHtml + `<p>${formattedReview}</p>`;

      if (data.koordinat && data.koordinat.lat && data.koordinat.lon) {
        const lat = parseFloat(data.koordinat.lat);
        const lon = parseFloat(data.koordinat.lon);

        map.setView([lat, lon], 11);

        currentMarker = L.marker([lat, lon])
          .addTo(map)
          .bindPopup(
            `
                            <div class="text-center">
                                <b class="text-sm block mb-1">Lokasi Kejadian</b>
                                <span class="text-xs text-gray-600">${
                                  data.lokasi_kejadian
                                }</span>
                                <br>
                                <span class="text-xs font-bold">${
                                  data.koordinat.nama_lengkap || ""
                                }</span>
                            </div>
                          `
          )
          .openPopup();
      } else {
        modalLocationText.textContent += " (Koordinat tidak ditemukan)";
      }

      if (!premiumToggle.checked) {
        if (blurOverlay) blurOverlay.style.display = "flex";
      }
    } catch (error) {
      reviewLoader.style.display = "none";
      mapLoadingOverlay.style.display = "none";
      reviewContent.innerHTML = `<p class="text-red-500">Gagal memuat analisis: ${error.message}</p>`;
      console.error("Article analysis error:", error);
    }
  }
});
