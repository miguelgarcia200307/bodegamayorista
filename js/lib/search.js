import { getBrands, getCategories, searchProducts } from './api.js';
import { isPromoActive, normalizeText } from './helpers.js';

const RECENT_KEY = 'bodega_mayorista_fc_recent_searches_v1';
const MAX_RECENT = 6;
let entitiesPromise;

function loadEntities() {
  if (!entitiesPromise) {
    entitiesPromise = Promise.all([getCategories(), getBrands()])
      .then(([categories, brands]) => ({ categories, brands }))
      .catch(error => {
        entitiesPromise = null;
        throw error;
      });
  }
  return entitiesPromise;
}

function matches(item, query) {
  const words = normalizeText(query).split(' ').filter(Boolean);
  const value = normalizeText(`${item.name || ''} ${item.description || ''}`);
  return words.every(word => value.includes(word)) || value.includes(normalizeText(query));
}

function uniqueByName(items, limit) {
  const seen = new Set();
  return items.filter(item => {
    const key = normalizeText(item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

// Categorías principales activas, en el orden definido en el panel.
export async function getPopularCategories(limit = 6) {
  const { categories } = await loadEntities();
  return categories.filter(category => !category.parent_id && category.slug !== 'promo').slice(0, limit);
}

export function getRecentSearches() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function saveRecentSearch(term) {
  const clean = String(term || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) return;
  const normalized = normalizeText(clean);
  const next = [clean, ...getRecentSearches().filter(item => normalizeText(item) !== normalized)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function clearRecentSearches() {
  localStorage.removeItem(RECENT_KEY);
}

export async function getSearchSuggestions(term, productLimit = 6) {
  const clean = String(term || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) return { products: [], categories: [], brands: [] };
  const [products, entities] = await Promise.all([searchProducts(clean, productLimit), loadEntities()]);
  const words = normalizeText(clean).split(' ').filter(Boolean);
  const strongProducts = products.filter(product => {
    const value = normalizeText(`${product.name || ''} ${product.brand_name || ''}`);
    return words.filter(word => value.includes(word)).length >= Math.ceil(words.length / 2);
  });
  const relevantProducts = strongProducts.length ? strongProducts : products;
  return {
    products: relevantProducts.map(product => ({ ...product, promotion: isPromoActive(product) })),
    categories: uniqueByName(entities.categories.filter(item => matches(item, clean)), 2),
    brands: uniqueByName(entities.brands.filter(item => matches(item, clean)), 1)
  };
}
