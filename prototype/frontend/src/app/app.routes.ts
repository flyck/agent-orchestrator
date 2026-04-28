import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'home',
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
    title: 'Home',
  },
  {
    path: 'review',
    loadComponent: () => import('./pages/review/review').then((m) => m.ReviewPage),
    title: 'Review',
  },
  {
    path: 'background',
    loadComponent: () => import('./pages/background/background').then((m) => m.BackgroundPage),
    title: 'Background',
  },
  {
    path: 'architecture',
    loadComponent: () =>
      import('./pages/architecture/architecture').then((m) => m.ArchitecturePage),
    title: 'Architecture',
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsPage),
    title: 'Settings',
  },
  {
    path: 'cost',
    loadComponent: () => import('./pages/cost/cost').then((m) => m.CostPage),
    title: 'Cost',
  },
  { path: '**', redirectTo: 'home' },
];
