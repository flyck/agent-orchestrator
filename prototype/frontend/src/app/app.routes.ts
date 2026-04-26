import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'review' },
  {
    path: 'review',
    loadComponent: () => import('./pages/review/review').then((m) => m.ReviewPage),
    title: 'Review',
  },
  {
    path: 'feature',
    loadComponent: () => import('./pages/feature/feature').then((m) => m.FeaturePage),
    title: 'Feature',
  },
  {
    path: 'bugfix',
    loadComponent: () => import('./pages/bugfix/bugfix').then((m) => m.BugfixPage),
    title: 'Bugfix',
  },
  {
    path: 'arch',
    loadComponent: () => import('./pages/arch/arch').then((m) => m.ArchPage),
    title: 'Arch Compare',
  },
  {
    path: 'background',
    loadComponent: () => import('./pages/background/background').then((m) => m.BackgroundPage),
    title: 'Background',
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
  { path: '**', redirectTo: 'review' },
];
