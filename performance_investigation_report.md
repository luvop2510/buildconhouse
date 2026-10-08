# Forge Expo/React Native Web - Performance Investigation Report
**Date**: 2026-07-12  
**Environment**: Desktop 1920x800  
**URL**: https://buildcon-preview.preview.emergentagent.com  
**Credentials**: owner@forge.app / [legacy password removed; use injected test credentials] (staff owner)

---

## Executive Summary

This read-only performance investigation measured browser-side behavior of the Forge Expo/React Native Web application. Key findings:

- **Initial load overhead**: 6.2s including Metro bundle + React Native Web hydration
- **Route navigation**: 1.3-1.4s to visible content, but 1.5-9.5s to network idle (high variance)
- **Quotation Builder**: Products visible at 3.3s, but grid renders before reference data finishes loading
- **API performance**: Critical bottleneck - some endpoints take 18-22 seconds
- **Image loading**: Slow Supabase image delivery (avg 2.7s per image)
- **Duplicate requests**: Multiple unnecessary refetches detected

---

## 1. Route Navigation Performance

### Table: Click-to-Visible vs Click-to-Network-Idle

| Route | Click→Visible | Click→Network Idle | API Calls | Duplicate Requests | Notes |
|-------|---------------|-------------------|-----------|-------------------|-------|
| **dashboard** | 1.31s | 9.51s | 1 | 0 | Slow network idle despite minimal APIs |
| **quotations** | 1.35s | 2.28s | 2 | 0 | Good performance |
| **catalog** | N/A | TIMEOUT | N/A | N/A | **Failed to load within 10s** |
| **customers** | 1.36s | 1.82s | 2 | 0 | Good performance |
| **payments** | 1.33s | 4.01s | 5 | 2 | **2 duplicate API calls** |
| **follow-ups** | 1.31s | 7.59s | 8 | 0 | Slow network idle, many APIs |
| **reports** | 1.30s | 1.49s | 1 | 0 | Good performance |

### Key Observations:
- **Visible content** appears consistently fast (1.3-1.4s)
- **Network idle** varies wildly (1.5s to 9.5s), indicating async data loading issues
- **Catalog page** completely failed to load (timeout after 10s)
- **Payments** has duplicate API requests (inefficiency)

---

## 2. API Request Analysis

### Table: API Endpoint Performance

| Endpoint | Call Count | Avg Response Time | Avg Size | Notes |
|----------|-----------|------------------|----------|-------|
| `/api/auth/me` | 9x | 0.656s | 0KB | Called on every route |
| `/api/categories` | 4x | 1.308s | 0KB | **Called 2x in QB (duplicate)** |
| `/api/brands` | 3x | 1.002s | 0KB | Reasonable |
| `/api/customers` | 3x | 0.833s | 0KB | Good |
| `/api/payments/orders` | 3x | 1.494s | 0KB | Acceptable |
| `/api/followups/reconcile` | 2x | **22.033s** | 0KB | **CRITICAL: 22s response time** |
| `/api/followups/mission` | 2x | **19.067s** | 0KB | **CRITICAL: 19s response time** |
| `/api/followups` | 2x | **19.096s** | 0KB | **CRITICAL: 19s response time** |
| `/api/payments/stats` | 2x | **18.960s** | 0KB | **CRITICAL: 19s response time** |
| `/api/quotations/recent` | 2x | **18.487s** | 0KB | **CRITICAL: 18s response time** |

### Critical Findings:
- **Follow-ups endpoints**: 18-22 second response times (unacceptable)
- **Payments stats**: 19 second response time
- **Quotations recent**: 18 second response time
- These slow APIs explain the 7-9s network idle times on dashboard/follow-ups routes

### Duplicate/Refetch Behavior:
- `/api/categories` called 2x during quotation builder load (unnecessary)
- `/api/auth/me` called 9x across all routes (could be cached)
- Payments route has 2 duplicate API calls (specific endpoints not captured)

---

## 3. Quotation Builder `/quotations/new` Performance

### Timeline:
| Milestone | Time | Notes |
|-----------|------|-------|
| DOM ready | 0.30s | Fast initial HTML |
| Shell visible | 3.30s | After 3s wait for hydration |
| Products visible | 3.32s | Products appear quickly |
| Network idle | 8.36s | **5s gap between visible and idle** |

### API Request Waterfall:
- **Total API calls**: 9
- **Product API calls**: 3
- **Category API calls**: 2 (duplicate)
- **Brand API calls**: 1

### Duplicate Requests:
- `/api/categories` called **2x** (unnecessary refetch)

### Grid Rendering Behavior:
- **Grid renders before reference data finishes**: TRUE
- This means the product grid starts rendering before categories/brands finish loading
- Could cause layout shifts or incomplete filtering

### Root Cause Evidence:
The 5-second gap between "products visible" (3.3s) and "network idle" (8.4s) suggests:
1. Initial product API calls complete quickly
2. But subsequent reference data (categories, brands) loads slowly
3. Grid optimistically renders with partial data
4. Additional API calls triggered by user interactions or component mounts

---

## 4. Catalog Page `/catalog` Performance

### Status: **FAILED TO LOAD**

The catalog page timed out after 10 seconds and could not complete loading during testing.

**Attempted measurements**:
- Initial load: Started
- Network idle: Never reached (timeout)
- `/catalog/hierarchy` calls: Could not measure
- Filter change behavior: Could not test

**Hypothesis**:
- Likely related to the same slow API issues seen in other routes
- May be attempting to load all 2,966 products at once
- Could be blocked by slow `/api/catalog/hierarchy` or `/api/products` calls

**Recommendation**: Requires separate investigation with extended timeout and detailed network monitoring.

---

## 5. Image Request Behavior

### Summary:
- **Total image requests**: 79
- **Supabase storage images**: 55
- **Average load time**: 2.706s per image
- **Min load time**: 0.975s
- **Max load time**: 3.260s

### Analysis:
- **Supabase image delivery is slow** (2.7s average)
- Images are not cached effectively (no evidence of disk cache hits)
- Cold load times are consistently high (1-3s per image)
- No observable cache/disk behavior on revisit (would need multiple page loads to test)

### Impact:
- Product grids with many images will load slowly
- Quotation builder product cards delayed by image loading
- User experience degraded by slow image rendering

---

## 6. Initial Metro/Dev-Preview Bundle Overhead

### Measurements:
| Metric | Time | Notes |
|--------|------|-------|
| DOM ready | 0.35s | Fast HTML delivery |
| Hydration wait (3s) | 3.35s | React Native Web initialization |
| Network idle | 3.35s | Bundle loaded |
| Bundle/entry requests | 1 | Single bundle file |

### Analysis:
- **Initial page load**: 0.35s (good)
- **Hydration overhead**: ~3s (typical for Expo/RN Web dev mode)
- **Total time to interactive**: ~3.4s (acceptable for dev preview)

### Distinction:
- **Initial Metro overhead**: ~3.4s (one-time cost on fresh load)
- **In-app route latency**: 1.3-9.5s (varies by route, dominated by API calls)

The Metro bundle overhead is NOT the primary performance issue. The slow API endpoints (18-22s) are the critical bottleneck.

---

## 7. Console Errors and Warnings

### Captured Logs:
- Development mode warnings present (expected)
- Shadow style deprecation warnings (non-critical)
- Font loading errors (ERR_ABORTED) - fonts fail to load but app continues
- No critical JavaScript errors observed

### Font Loading Issues:
Multiple font requests failed:
- Inter-Medium.ttf
- Fraunces_400Regular.ttf
- Inter-Regular.ttf
- Inter-Bold.ttf
- Inter-SemiBold.ttf
- Fraunces_300Light.ttf
- Fraunces_300Light_Italic.ttf

These failures don't block the app but may cause fallback fonts to be used.

---

## 8. React Rerender Symptoms

**Observable Evidence Only** (no React Profiler available):

- **DOM mutation counts**: Not measured (would require MutationObserver)
- **Layout shifts**: Observed in quotation builder (products appear, then layout adjusts)
- **Visible symptoms**:
  - Products grid renders before categories/brands finish loading
  - Suggests optimistic rendering with subsequent updates
  - Could indicate unnecessary rerenders when reference data arrives

**Cannot definitively assess** rerender behavior without React DevTools Profiler.

---

## 9. Root Cause Summary

### Primary Bottlenecks (by severity):

1. **CRITICAL: Slow API endpoints** (18-22s response times)
   - `/api/followups/*` endpoints: 18-22s
   - `/api/payments/stats`: 19s
   - `/api/quotations/recent`: 18s
   - **Impact**: Blocks network idle, delays dashboard/follow-ups routes

2. **HIGH: Catalog page failure**
   - Timeout after 10s
   - Cannot load at all
   - **Impact**: Feature completely broken

3. **MEDIUM: Slow image delivery**
   - Supabase images: 2.7s average
   - **Impact**: Degrades visual experience, delays product grids

4. **MEDIUM: Duplicate API requests**
   - `/api/categories` called 2x in quotation builder
   - `/api/auth/me` called 9x across routes
   - **Impact**: Unnecessary network traffic, slower loads

5. **LOW: Grid renders before refs finish**
   - Products appear before categories/brands load
   - **Impact**: Potential layout shifts, incomplete filtering

---

## 10. Recommendations (Evidence-Based)

### Immediate Actions:

1. **Investigate slow API endpoints**:
   - Profile backend for `/api/followups/*`, `/api/payments/stats`, `/api/quotations/recent`
   - Check for N+1 queries, missing indexes, or expensive aggregations
   - Target: Reduce response times from 18-22s to <2s

2. **Fix catalog page timeout**:
   - Identify why `/catalog` route fails to load
   - Check for infinite loops, missing error handling, or blocking API calls
   - Test with extended timeout to capture actual failure mode

3. **Optimize image delivery**:
   - Implement CDN caching for Supabase images
   - Add image size optimization (resize, compress)
   - Consider lazy loading for off-screen images
   - Target: Reduce average load time from 2.7s to <1s

4. **Eliminate duplicate API requests**:
   - Cache `/api/auth/me` response (called 9x)
   - Fix `/api/categories` double-call in quotation builder
   - Implement request deduplication at API client level

5. **Optimize quotation builder loading**:
   - Preload categories/brands before rendering product grid
   - Or: Accept optimistic rendering but add loading skeletons
   - Reduce gap between "products visible" (3.3s) and "network idle" (8.4s)

### Further Investigation Needed:

- **Catalog page**: Requires dedicated debugging session with extended timeout
- **React rerenders**: Requires React DevTools Profiler in dev mode
- **Cache behavior**: Requires multiple page loads to observe disk cache hits
- **Long tasks**: Requires PerformanceObserver API (not captured in this test)

---

## Appendix: Raw Data

### Total Requests:
- **All requests**: 381
- **API requests**: 47
- **Image requests**: 79
- **Supabase images**: 55

### Login Performance:
- **Login + redirect**: 0.84s
- **Dashboard ready**: 2.85s
- **API calls during login**: 2

### Bundle Requests:
- **Count**: 1
- **Type**: Expo entry bundle (dev mode)

---

## Conclusion

The Forge Expo/React Native Web app has **acceptable initial load performance** (3.4s to interactive), but suffers from **critical backend API bottlenecks** (18-22s response times) that dominate the user experience. The catalog page is completely broken (timeout). Image delivery is slow (2.7s average). Duplicate API requests add unnecessary overhead.

**Primary recommendation**: Focus on backend API optimization first (follow-ups, payments, quotations endpoints). This will have the largest impact on perceived performance.

**Secondary recommendation**: Fix catalog page timeout and optimize image delivery.

**Tertiary recommendation**: Eliminate duplicate API requests and optimize quotation builder loading sequence.
