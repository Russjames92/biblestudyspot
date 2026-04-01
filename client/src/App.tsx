import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { AuthProvider, AuthErrorBoundary } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { Toaster } from "@/components/ui/toaster";
import HomePage from "@/pages/home";
import AdminPage from "@/pages/admin";
import TeacherPage from "@/pages/teacher";
import AboutPage from "@/pages/about";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <Router hook={useHashLocation}>
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/about" component={AboutPage} />
        <Route path="/admin" component={AdminPage} />
        <Route path="/teacher" component={TeacherPage} />
        <Route component={NotFound} />
      </Switch>
    </Router>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <AuthErrorBoundary>
            <AppRouter />
          </AuthErrorBoundary>
          <Toaster />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
