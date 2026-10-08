
ADMIN@DESKTOP-2NOEEN2 MINGW64 ~/Desktop/marketmix real estate/marketmix-realestates (main)
$ sed -n '1,200p' src/components/dashboards/AdminDashboard.jsx | head -n 200
// src/components/dashboards/AdminDashboard.jsx - FULL FIXED & ENHANCED VERSION WITH ALL PAGES EDITOR (HOME, EXPLORE, ABOUT, AGENTS)
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Users, Building, BarChart, TrendingUp, DollarSign, Eye,
  RefreshCw, Settings, Upload, Trash2, Edit, Plus, MapPin,
  Bed, Bath, Square, Home, Tag, Star, Layout,
  Globe, Mail, Phone, Award, CheckCircle, XCircle,
  Save, AlertCircle, Crown, Shield, Image as ImageIcon,
  Facebook, Twitter, Instagram, Linkedin, Youtube, MessageCircle,
  Maximize2, Crop, Loader, UserCog, UserCheck, UserX, Filter, Search,
  Briefcase, User, Shield as ShieldIcon, UserMinus, Clock, Check, X,
  Eye as EyeIcon, Calendar, Flag, Info, Truck, Package, Building2, Compass
} from 'lucide-react';
import { db } from '../../firebase/config';
import {
  collection, getDocs, query, orderBy, deleteDoc, doc,
  addDoc, serverTimestamp, setDoc, getDoc, updateDoc, where,
  limit
} from 'firebase/firestore';
import toast from 'react-hot-toast';
import { resolvePropertyImage } from '../../utils/propertyMapping';
import PromotePropertyModal from '../PromotePropertyModal';
import AgencyPackagesPage from '../../pages/admin/AgencyPackagesPage';
import SightseeingPackagesPage from '../../pages/admin/SightseeingPackagesPage';
import MovingPackagesPage from '../../pages/admin/MovingPackagesPage';
import TransportRequestsPage from '../../pages/admin/TransportRequestsPage';
import AdminServiceRequestsPage from '../../pages/admin/ServiceRequestsPage';
import WhatsAppControl from '../../pages/admin/WhatsAppControl';
import { useAuth } from '../../context/AuthContext';

const YOUTUBE_ADMIN_API = import.meta.env.VITE_YOUTUBE_API_URL || 'https://marketmix-youtube-server.onrender.com';

const YOUR_ADMIN_BACKEND =
  import.meta.env.VITE_BACKEND_URL || 'https://backened-lt67.onrender.com';

// Glassmorphism styles
const glass = {
  background: 'rgba(255,255,255,0.62)',
  backdropFilter: 'blur(20px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(20px) saturate(1.3)',
  border: '1px solid rgba(255,255,255,0.45)',
  borderRadius: 20,
};

const serif = "'Cormorant Garamond', 'Georgia', serif";
const sans = "'Inter', system-ui, sans-serif";
const ink = '#1c1c1e';
const ink2 = '#4a4a52';
const ink3 = '#8e8e99';
const rule = 'rgba(255,255,255,0.2)';
const red = '#dc2626';
const redLight = 'rgba(220,38,38,0.12)';
const green = '#10b981';
const greenLight = 'rgba(16,185,129,0.12)';
const yellow = '#f59e0b';
const yellowLight = 'rgba(245,158,11,0.12)';

const AdminDashboard = () => {
  const { currentUser } = useAuth();
  const [activeSection, setActiveSection] = useState('listings');
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [pendingListings, setPendingListings] = useState([]);
  const [approvedListings, setApprovedListings] = useState([]);
  const [rejectedListings, setRejectedListings] = useState([]);
  const [featuredListings, setFeaturedListings] = useState([]);
  const [users, setUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('pending');
  const [allowedOrigins, setAllowedOrigins] = useState([]);
  const [originInput, setOriginInput] = useState('');
  const [originLoading, setOriginLoading] = useState(false);
  const [originSaving, setOriginSaving] = useState(false);
  const [originError, setOriginError] = useState('');
  const [promoteProperty, setPromoteProperty] = useState(null);
  const [agentProfileUserId, setAgentProfileUserId] = useState(null);
  const [showAgentProfileModal, setShowAgentProfileModal] = useState(false);
  const [agentProfileDraft, setAgentProfileDraft] = useState({
    name: '',
    email: '',
    phone: '',
    photo: '',
    title: 'Real Estate Agent',
    bio: '',
    specialties: ['Residential'],
    languages: ['English'],
    experience: 1,
    rating: 4.8,
    propertiesSold: 0,
    office: ''
  });

  // Full Seller Info Modal State
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [selectedPropertyInfo, setSelectedPropertyInfo] = useState(null);

  // Approval with Homepage Placement Modal State
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalPropertyId, setApprovalPropertyId] = useState(null);
  const [selectedPlacements, setSelectedPlacements] = useState(['featured', 'main']);

  // Pages Editor Sub-tab State
  const [editorSubTab, setEditorSubTab] = useState('homepage');

  // Homepage Settings Form State
  const [homepageForm, setHomepageForm] = useState({
    hero: {
      title: 'Discover Timeless Properties in Kenya',
      subtitle: 'Premium real estate with uncompromising standards.',
      backgroundImage: '/images/property-hero.svg',
      searchPlaceholder: 'Search properties by location or type...'
    },
    cta: {
      title: 'Begin Your Property Journey',
      subtitle: 'Connect with our expert agents for personalized property consultations',
      button1Text: 'Browse Properties',
      button1Link: '/properties',
      button2Text: 'Schedule Consultation',
      button2Link: '/contact'
    },
    contactInfo: {
      email: 'info@realestate.com',
      phone: '0115988107',
      address: 'Nairobi, Kenya'
    },
    socialLinks: {
      facebook: '',
      twitter: '',
      instagram: '',
      linkedin: '',
      youtube: ''
    }
  });

  // Explore Page Settings Form State
  const [exploreForm, setExploreForm] = useState({
    title: 'Find Your Dream Property',
    subtitle: 'Discover homes, apartments, and commercial spaces across Kenya'
  });

  // About Page Settings Form State
  const [aboutForm, setAboutForm] = useState({
    title: 'About MarketMix',
    subtitle: 'Redefining real estate in Kenya with transparency, luxury, and trust.',
    story: 'MarketMix Real Estates is Kenya’s premier property platform connecting verified sellers, agents, investors, and buyers with world-class digital tools.'
  });

  // Agents Page Settings Form State
  const [agentsForm, setAgentsForm] = useState({
    title: 'Meet Our Real Estate Experts',
    subtitle: 'Connect with top-rated agents specializing in luxury homes, commercial properties, and rentals.',
    ctaTitle: 'Join Our Team of Experts',
    ctaSubtitle: 'Are you a real estate professional? Join MarketMix Real Estates and grow your career with us.'
  });

  const [customPageSlug, setCustomPageSlug] = useState('homepage');
  const [customPageJson, setCustomPageJson] = useState(JSON.stringify({
    title: 'Homepage',
    subtitle: 'Customize this page from the admin dashboard.'
  }, null, 2));

  // ---- Driver approvals ----
  const [allDrivers, setAllDrivers] = useState([]);
  const [driverFilter, setDriverFilter] = useState('pending');
  const [driverSavingId, setDriverSavingId] = useState('');


  const [stats, setStats] = useState({
    totalUsers: 0,
    totalProperties: 0,
    activeListings: 0,
    pendingApproval: 0,
    totalRevenue: 0
  });

  const roles = [
    { value: 'admin', label: 'Administrator', icon: <ShieldIcon size={16} /> },
    { value: 'moderator', label: 'Moderator', icon: <CheckCircle size={16} /> },
    { value: 'agent', label: 'Real Estate Agent', icon: <Briefcase size={16} /> },
    { value: 'seller', label: 'Seller/Landlord', icon: <Home size={16} /> },
    { value: 'investor', label: 'Investor', icon: <TrendingUp size={16} /> },
    { value: 'user', label: 'Regular User', icon: <Users size={16} /> }
  ];

  const loadProperties = async () => {
    setLoading(true);
    try {
      const propertiesRef = collection(db, 'properties');
      const querySnapshot = await getDocs(propertiesRef);
      const allProperties = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      const pending = allProperties.filter(p => p.verificationStatus === 'pending' || p.approvalStatus === 'pending' || (!p.verificationStatus && !p.approvalStatus));
      const approved = allProperties.filter(p => p.verificationStatus === 'approved' || p.approvalStatus === 'approved');
      const rejected = allProperties.filter(p => p.verificationStatus === 'rejected' || p.approvalStatus === 'rejected');

ADMIN@DESKTOP-2NOEEN2 MINGW64 ~/Desktop/marketmix real estate/marketmix-realestates (main)
$ ^C

ADMIN@DESKTOP-2NOEEN2 MINGW64 ~/Desktop/marketmix real estate/marketmix-realestates (main)
$ sed -n '1,2000p' src/components/dashboards/AdminDashboard.jsx > /tmp/AdminDashboard-current.txt
wc -l /tmp/AdminDashboard-current.txt
cat /tmp/AdminDashboard-current.txt
1877 /tmp/AdminDashboard-current.txt
// src/components/dashboards/AdminDashboard.jsx - FULL FIXED & ENHANCED VERSION WITH ALL PAGES EDITOR (HOME, EXPLORE, ABOUT, AGENTS)
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Users, Building, BarChart, TrendingUp, DollarSign, Eye,
  RefreshCw, Settings, Upload, Trash2, Edit, Plus, MapPin,
  Bed, Bath, Square, Home, Tag, Star, Layout,
  Globe, Mail, Phone, Award, CheckCircle, XCircle,
  Save, AlertCircle, Crown, Shield, Image as ImageIcon,
  Facebook, Twitter, Instagram, Linkedin, Youtube, MessageCircle,
  Maximize2, Crop, Loader, UserCog, UserCheck, UserX, Filter, Search,
  Briefcase, User, Shield as ShieldIcon, UserMinus, Clock, Check, X,
  Eye as EyeIcon, Calendar, Flag, Info, Truck, Package, Building2, Compass
} from 'lucide-react';
import { db } from '../../firebase/config';
import {
  collection, getDocs, query, orderBy, deleteDoc, doc,
  addDoc, serverTimestamp, setDoc, getDoc, updateDoc, where,
  limit
} from 'firebase/firestore';
import toast from 'react-hot-toast';
import { resolvePropertyImage } from '../../utils/propertyMapping';
import PromotePropertyModal from '../PromotePropertyModal';
import AgencyPackagesPage from '../../pages/admin/AgencyPackagesPage';
import SightseeingPackagesPage from '../../pages/admin/SightseeingPackagesPage';
import MovingPackagesPage from '../../pages/admin/MovingPackagesPage';
import TransportRequestsPage from '../../pages/admin/TransportRequestsPage';
import AdminServiceRequestsPage from '../../pages/admin/ServiceRequestsPage';
import WhatsAppControl from '../../pages/admin/WhatsAppControl';
import { useAuth } from '../../context/AuthContext';

const YOUTUBE_ADMIN_API = import.meta.env.VITE_YOUTUBE_API_URL || 'https://marketmix-youtube-server.onrender.com';

const YOUR_ADMIN_BACKEND =
  import.meta.env.VITE_BACKEND_URL || 'https://backened-lt67.onrender.com';

// Glassmorphism styles
const glass = {
  background: 'rgba(255,255,255,0.62)',
  backdropFilter: 'blur(20px) saturate(1.3)',
  WebkitBackdropFilter: 'blur(20px) saturate(1.3)',
  border: '1px solid rgba(255,255,255,0.45)',
  borderRadius: 20,
};

const serif = "'Cormorant Garamond', 'Georgia', serif";
const sans = "'Inter', system-ui, sans-serif";
const ink = '#1c1c1e';
const ink2 = '#4a4a52';
const ink3 = '#8e8e99';
const rule = 'rgba(255,255,255,0.2)';
const red = '#dc2626';
const redLight = 'rgba(220,38,38,0.12)';
const green = '#10b981';
const greenLight = 'rgba(16,185,129,0.12)';
const yellow = '#f59e0b';
const yellowLight = 'rgba(245,158,11,0.12)';

const AdminDashboard = () => {
  const { currentUser } = useAuth();
  const [activeSection, setActiveSection] = useState('listings');
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState([]);
  const [pendingListings, setPendingListings] = useState([]);
  const [approvedListings, setApprovedListings] = useState([]);
  const [rejectedListings, setRejectedListings] = useState([]);
  const [featuredListings, setFeaturedListings] = useState([]);
  const [users, setUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('pending');
  const [allowedOrigins, setAllowedOrigins] = useState([]);
  const [originInput, setOriginInput] = useState('');
  const [originLoading, setOriginLoading] = useState(false);
  const [originSaving, setOriginSaving] = useState(false);
  const [originError, setOriginError] = useState('');
  const [promoteProperty, setPromoteProperty] = useState(null);
  const [agentProfileUserId, setAgentProfileUserId] = useState(null);
  const [showAgentProfileModal, setShowAgentProfileModal] = useState(false);
  const [agentProfileDraft, setAgentProfileDraft] = useState({
    name: '',
    email: '',
    phone: '',
    photo: '',
    title: 'Real Estate Agent',
    bio: '',
    specialties: ['Residential'],
    languages: ['English'],
    experience: 1,
    rating: 4.8,
    propertiesSold: 0,
    office: ''
  });

  // Full Seller Info Modal State
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [selectedPropertyInfo, setSelectedPropertyInfo] = useState(null);

  // Approval with Homepage Placement Modal State
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalPropertyId, setApprovalPropertyId] = useState(null);
  const [selectedPlacements, setSelectedPlacements] = useState(['featured', 'main']);

  // Pages Editor Sub-tab State
  const [editorSubTab, setEditorSubTab] = useState('homepage');

  // Homepage Settings Form State
  const [homepageForm, setHomepageForm] = useState({
    hero: {
      title: 'Discover Timeless Properties in Kenya',
      subtitle: 'Premium real estate with uncompromising standards.',
      backgroundImage: '/images/property-hero.svg',
      searchPlaceholder: 'Search properties by location or type...'
    },
    cta: {
      title: 'Begin Your Property Journey',
      subtitle: 'Connect with our expert agents for personalized property consultations',
      button1Text: 'Browse Properties',
      button1Link: '/properties',
      button2Text: 'Schedule Consultation',
      button2Link: '/contact'
    },
    contactInfo: {
      email: 'info@realestate.com',
      phone: '0115988107',
      address: 'Nairobi, Kenya'
    },
    socialLinks: {
      facebook: '',
      twitter: '',
      instagram: '',
      linkedin: '',
      youtube: ''
    }
  });

  // Explore Page Settings Form State
  const [exploreForm, setExploreForm] = useState({
    title: 'Find Your Dream Property',
    subtitle: 'Discover homes, apartments, and commercial spaces across Kenya'
  });

  // About Page Settings Form State
  const [aboutForm, setAboutForm] = useState({
    title: 'About MarketMix',
    subtitle: 'Redefining real estate in Kenya with transparency, luxury, and trust.',
    story: 'MarketMix Real Estates is Kenya’s premier property platform connecting verified sellers, agents, investors, and buyers with world-class digital tools.'
  });

  // Agents Page Settings Form State
  const [agentsForm, setAgentsForm] = useState({
    title: 'Meet Our Real Estate Experts',
    subtitle: 'Connect with top-rated agents specializing in luxury homes, commercial properties, and rentals.',
    ctaTitle: 'Join Our Team of Experts',
    ctaSubtitle: 'Are you a real estate professional? Join MarketMix Real Estates and grow your career with us.'
  });

  const [customPageSlug, setCustomPageSlug] = useState('homepage');
  const [customPageJson, setCustomPageJson] = useState(JSON.stringify({
    title: 'Homepage',
    subtitle: 'Customize this page from the admin dashboard.'
  }, null, 2));

  // ---- Driver approvals ----
  const [allDrivers, setAllDrivers] = useState([]);
  const [driverFilter, setDriverFilter] = useState('pending');
  const [driverSavingId, setDriverSavingId] = useState('');


  const [stats, setStats] = useState({
    totalUsers: 0,
    totalProperties: 0,
    activeListings: 0,
    pendingApproval: 0,
    totalRevenue: 0
  });

  const roles = [
    { value: 'admin', label: 'Administrator', icon: <ShieldIcon size={16} /> },
    { value: 'moderator', label: 'Moderator', icon: <CheckCircle size={16} /> },
    { value: 'agent', label: 'Real Estate Agent', icon: <Briefcase size={16} /> },
    { value: 'seller', label: 'Seller/Landlord', icon: <Home size={16} /> },
    { value: 'investor', label: 'Investor', icon: <TrendingUp size={16} /> },
    { value: 'user', label: 'Regular User', icon: <Users size={16} /> }
  ];

  const loadProperties = async () => {
    setLoading(true);
    try {
      const propertiesRef = collection(db, 'properties');
      const querySnapshot = await getDocs(propertiesRef);
      const allProperties = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      const pending = allProperties.filter(p => p.verificationStatus === 'pending' || p.approvalStatus === 'pending' || (!p.verificationStatus && !p.approvalStatus));
      const approved = allProperties.filter(p => p.verificationStatus === 'approved' || p.approvalStatus === 'approved');
      const rejected = allProperties.filter(p => p.verificationStatus === 'rejected' || p.approvalStatus === 'rejected');
      const featured = allProperties.filter(p => p.featured === true && (p.verificationStatus === 'approved' || p.approvalStatus === 'approved'));

      setPendingListings(pending);
      setApprovedListings(approved);
      setRejectedListings(rejected);
      setFeaturedListings(featured);
      setProperties(allProperties);

      setStats(prev => ({
        ...prev,
        totalProperties: allProperties.length,
        activeListings: approved.length,
        pendingApproval: pending.length
      }));

    } catch (error) {
      console.error('Error loading properties:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const usersRef = collection(db, 'users');
      const querySnapshot = await getDocs(usersRef);
      const usersList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setUsers(usersList);
      setFilteredUsers(usersList);
      setStats(prev => ({ ...prev, totalUsers: usersList.length }));
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const loadAllowedOrigins = async () => {
    if (!currentUser) return;
    setOriginLoading(true);
    setOriginError('');
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${YOUTUBE_ADMIN_API}/api/admin/allowed-origins`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load website domains');
      setAllowedOrigins(result.allowedOrigins || []);
    } catch (error) {
      console.error('Error loading YouTube API domains:', error);
      setOriginError(error.message || 'Unable to connect to the YouTube server');
    } finally {
      setOriginLoading(false);
    }
  };

  const handleAddOrigin = (event) => {
    event.preventDefault();
    setOriginError('');
    try {
      const input = originInput.trim();
      const url = new URL(input);
      const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !localHttp) || url.origin !== input) {
        throw new Error('Enter a secure website origin only, such as https://example.com (no path).');
      }
      if (allowedOrigins.includes(url.origin)) {
        throw new Error('That domain is already allowed.');
      }
      setAllowedOrigins((origins) => [...origins, url.origin]);
      setOriginInput('');
    } catch (error) {
      setOriginError(error.message || 'Enter a valid website origin.');
    }
  };

  const handleSaveOrigins = async () => {
    if (!currentUser) return;
    setOriginSaving(true);
    setOriginError('');
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch(`${YOUTUBE_ADMIN_API}/api/admin/allowed-origins`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allowedOrigins }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save website domains');
      setAllowedOrigins(result.allowedOrigins || []);
      toast.success('Allowed website domains updated.');
    } catch (error) {
      console.error('Error saving YouTube API domains:', error);
      setOriginError(error.message || 'Unable to save website domains');
      toast.error('Could not save allowed domains.');
    } finally {
      setOriginSaving(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'apiDomains') loadAllowedOrigins();
  }, [activeSection, currentUser]);

  useEffect(() => {
    const term = searchTerm.trim().toLowerCase();
    const nextUsers = users.filter(user => {
      const role = user.role || 'user';
      const matchesRole = selectedRole === 'all' || role === selectedRole;
      const haystack = `${user.name || ''} ${user.email || ''} ${role}`.toLowerCase();
      const matchesSearch = !term || haystack.includes(term);
      return matchesRole && matchesSearch;
    });
    setFilteredUsers(nextUsers);
  }, [users, searchTerm, selectedRole]);

  const loadAllPagesSettings = async () => {
    try {
      const homeSnap = await getDoc(doc(db, 'settings', 'homepage'));
      if (homeSnap.exists()) setHomepageForm(prev => ({ ...prev, ...homeSnap.data() }));

      const exploreSnap = await getDoc(doc(db, 'settings', 'explore'));
      if (exploreSnap.exists()) setExploreForm(prev => ({ ...prev, ...exploreSnap.data() }));

      const aboutSnap = await getDoc(doc(db, 'settings', 'about'));
      if (aboutSnap.exists()) setAboutForm(prev => ({ ...prev, ...aboutSnap.data() }));

      const agentsSnap = await getDoc(doc(db, 'settings', 'agents'));
      if (agentsSnap.exists()) setAgentsForm(prev => ({ ...prev, ...agentsSnap.data() }));
    } catch (error) {
      console.error('Error loading pages settings:', error);
    }
  };

  const loadDrivers = async () => {
    try {
      const snap = await getDocs(collection(db, 'users'));
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const drivers = all.filter(u =>
        u.driverProfile ||
        u.driverApproved === true ||
        u.driverStatus === 'approved' ||
        u.driverStatus === 'rejected' ||
        u.driverStatus === 'pending'
      );
      setAllDrivers(drivers);
    } catch (e) {
      console.error('Error loading drivers:', e);
      toast.error('Could not load driver applications.');
    }
  };

  useEffect(() => {
    loadProperties();
    loadUsers();
    loadAllPagesSettings();
    loadDrivers();
  }, []);

  const handleSaveHomepageSettings = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await setDoc(doc(db, 'settings', 'homepage'), homepageForm, { merge: true });
      toast.success('Homepage updated successfully!');
    } catch (error) {
      console.error('Error saving homepage:', error);
      toast.error('Failed to update homepage');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveExploreSettings = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await setDoc(doc(db, 'settings', 'explore'), exploreForm, { merge: true });
      toast.success('Explore Page updated successfully!');
    } catch (error) {
      console.error('Error saving explore page:', error);
      toast.error('Failed to update explore page');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAboutSettings = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await setDoc(doc(db, 'settings', 'about'), aboutForm, { merge: true });
      toast.success('About Page updated successfully!');
    } catch (error) {
      console.error('Error saving about page:', error);
      toast.error('Failed to update about page');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAgentsSettings = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await setDoc(doc(db, 'settings', 'agents'), agentsForm, { merge: true });
      toast.success('Agents Page updated successfully!');
    } catch (error) {
      console.error('Error saving agents page:', error);
      toast.error('Failed to update agents page');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadCustomPage = async (pageSlug) => {
    try {
      const pageSnap = await getDoc(doc(db, 'settings', pageSlug));
      if (pageSnap.exists()) {
        setCustomPageJson(JSON.stringify(pageSnap.data(), null, 2));
      } else {
        setCustomPageJson(JSON.stringify({ title: `${pageSlug} page`, subtitle: 'Page content', status: 'draft' }, null, 2));
      }
    } catch (error) {
      console.error('Error loading custom page:', error);
      toast.error('Unable to load the selected page');
    }
  };

  const handleSaveCustomPageSettings = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const parsed = JSON.parse(customPageJson);
      await setDoc(doc(db, 'settings', customPageSlug), parsed, { merge: true });
      toast.success(`Page "${customPageSlug}" updated successfully.`);
    } catch (error) {
      console.error('Error saving custom page:', error);
      toast.error('Custom page JSON is invalid. Fix the format and try again.');
    } finally {
      setLoading(false);
    }
  };

  // Open Approval Modal
  const handleOpenApproval = (listingId) => {
    setApprovalPropertyId(listingId);
    setSelectedPlacements(['featured', 'main']);
    setShowApprovalModal(true);
  };

  // Confirm Approval with Homepage Placements
  const handleConfirmApproval = async () => {
    if (!approvalPropertyId) return;
    setLoading(true);
    try {
      const listingRef = doc(db, 'properties', approvalPropertyId);
      await updateDoc(listingRef, {
        verificationStatus: 'approved',
        approvalStatus: 'approved',
        status: 'active',
        featured: selectedPlacements.includes('featured'),
        homepagePlacements: selectedPlacements,
        approvedAt: serverTimestamp()
      });

      toast.success('Listing approved & published to selected homepage sections!');
      setShowApprovalModal(false);
      setApprovalPropertyId(null);
      await loadProperties();
    } catch (error) {
      console.error('Error approving listing:', error);
      toast.error('Failed to approve listing');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePlacements = async (listingId, newPlacements) => {
    setLoading(true);
    try {
      const listingRef = doc(db, 'properties', listingId);
      await updateDoc(listingRef, {
        homepagePlacements: newPlacements,
        featured: newPlacements.includes('featured'),
        updatedAt: serverTimestamp()
      });
      toast.success('Homepage placements updated successfully.');
      await loadProperties();
    } catch (error) {
      console.error('Error updating placements:', error);
      toast.error('Failed to update placements');
    } finally {
      setLoading(false);
    }
  };

  const handleRejectListing = async (listingId) => {
    const reason = prompt('Please provide a reason for rejection:');
    if (reason === null) return;

    setLoading(true);
    try {
      const listingRef = doc(db, 'properties', listingId);
      await updateDoc(listingRef, {
        verificationStatus: 'rejected',
        approvalStatus: 'rejected',
        rejectionReason: reason,
        rejectedAt: serverTimestamp(),
        status: 'rejected'
      });

      await loadProperties();
      toast.warning(`Listing rejected: ${reason}`);
    } catch (error) {
      console.error('Error rejecting listing:', error);
      toast.error('Failed to reject listing');
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeApproval = async (listingId) => {
    if (window.confirm('Are you sure you want to revoke approval for this listing? It will go back to pending status.')) {
      setLoading(true);
      try {
        const listingRef = doc(db, 'properties', listingId);
        await updateDoc(listingRef, {
          verificationStatus: 'pending',
          approvalStatus: 'pending',
          revokedAt: serverTimestamp(),
          featured: false,
          homepagePlacements: []
        });

        await loadProperties();
        toast.warning('Listing approval revoked. It is now pending review again.');
      } catch (error) {
        console.error('Error revoking approval:', error);
        toast.error('Failed to revoke approval');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleDeleteListing = async (listingId) => {
    if (window.confirm('Are you sure you want to permanently delete this listing?')) {
      setLoading(true);
      try {
        await deleteDoc(doc(db, 'properties', listingId));
        await loadProperties();
        toast.success('Listing deleted successfully');
      } catch (error) {
        console.error('Error deleting listing:', error);
        toast.error('Failed to delete listing');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleUpdateUserRole = async (userId, newRole) => {
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, {
        role: newRole,
        userType: newRole,
        updatedAt: serverTimestamp()
      });
      setUsers(prev => prev.map(user => user.id === userId ? { ...user, role: newRole, userType: newRole } : user));
      toast.success('User role updated successfully');
    } catch (error) {
      console.error('Error updating user role:', error);
      toast.error('Failed to update user role');
    }
  };

  const openAgentProfileEditor = (user) => {
    const profile = user.agentProfile || {};
    setAgentProfileUserId(user.id);
    setAgentProfileDraft({
      name: profile.name || user.name || '',
      email: profile.email || user.email || '',
      phone: profile.phone || user.phone || '',
      photo: profile.photo || '',
      title: profile.title || 'Real Estate Agent',
      bio: profile.bio || '',
      specialties: Array.isArray(profile.specialties) && profile.specialties.length ? profile.specialties : ['Residential'],
      languages: Array.isArray(profile.languages) && profile.languages.length ? profile.languages : ['English'],
      experience: Number(profile.experience ?? user.experience ?? 1),
      rating: Number(profile.rating ?? user.rating ?? 4.8),
      propertiesSold: Number(profile.propertiesSold ?? user.propertiesSold ?? 0),
      office: profile.office || ''
    });
    setShowAgentProfileModal(true);
  };

  const handleSaveAgentProfile = async (e) => {
    e.preventDefault();
    if (!agentProfileUserId) return;

    try {
      const userRef = doc(db, 'users', agentProfileUserId);
      const payload = {
        role: 'agent',
        userType: 'agent',
        email: agentProfileDraft.email,
        name: agentProfileDraft.name,
        phone: agentProfileDraft.phone,
        photo: agentProfileDraft.photo,
        agentProfile: {
          name: agentProfileDraft.name,
          email: agentProfileDraft.email,
          phone: agentProfileDraft.phone,
          photo: agentProfileDraft.photo,
          title: agentProfileDraft.title,
          bio: agentProfileDraft.bio,
          specialties: Array.isArray(agentProfileDraft.specialties) ? agentProfileDraft.specialties : String(agentProfileDraft.specialties || '').split(',').map(item => item.trim()).filter(Boolean),
          languages: Array.isArray(agentProfileDraft.languages) ? agentProfileDraft.languages : String(agentProfileDraft.languages || '').split(',').map(item => item.trim()).filter(Boolean),
          experience: Number(agentProfileDraft.experience || 1),
          rating: Number(agentProfileDraft.rating || 4.8),
          propertiesSold: Number(agentProfileDraft.propertiesSold || 0),
          office: agentProfileDraft.office,
          updatedAt: serverTimestamp()
        },
        updatedAt: serverTimestamp()
      };

      await updateDoc(userRef, payload);
      setUsers(prev => prev.map(user => user.id === agentProfileUserId ? { ...user, ...payload, agentProfile: payload.agentProfile } : user));
      setShowAgentProfileModal(false);
      toast.success('Agent profile saved successfully.');
    } catch (error) {
      console.error('Error saving agent profile:', error);
      toast.error('Failed to save agent profile.');
    }
  };

  const handleDeleteUser = async (userId, userName) => {
    if (window.confirm(`Are you sure you want to delete user "${userName}"?`)) {
      try {
        await deleteDoc(doc(db, 'users', userId));
        setUsers(prev => prev.filter(user => user.id !== userId));
        toast.success('User deleted successfully');
      } catch (error) {
        console.error('Error deleting user:', error);
        toast.error('Failed to delete user');
      }
    }
  };

  const handleDriverDecision = async (driver, decision) => {
    if (!driver) return;
    if (!currentUser) { toast.error('Sign in as admin.'); return; }
    let reason = '';
    if (decision === 'reject') {
      reason = window.prompt('Reason for rejection (sent to driver):', 'Documents unclear');
      if (reason === null) return;
    }
    setDriverSavingId(driver.id);
    try {
      const userRef = doc(db, 'users', driver.id);
      const updateData = decision === 'approve'
        ? { driverApproved: true, driverStatus: 'approved', role: 'driver', driverRejectionReason: null, updatedAt: serverTimestamp() }
        : { driverApproved: false, driverStatus: 'rejected', driverRejectionReason: reason || 'Documents unclear', updatedAt: serverTimestamp() };

      await updateDoc(userRef, updateData);
      toast.success(decision === 'approve' ? `Approved ${driver.name || driver.email}` : `Rejected ${driver.name || driver.email}`);
      await loadDrivers();
    } catch (e) {
      console.error('Error updating driver decision:', e);
      toast.error(e.message || 'Could not update driver.');
    } finally {
      setDriverSavingId('');
    }
  };

  const getStatusBadge = (status) => {
    switch(status) {
      case 'pending':
        return { bg: yellowLight, color: yellow, label: 'Pending Review', icon: <Clock size={12} /> };
      case 'approved':
        return { bg: greenLight, color: green, label: 'Approved', icon: <Check size={12} /> };
      case 'rejected':
        return { bg: redLight, color: red, label: 'Rejected', icon: <X size={12} /> };
      default:
        return { bg: yellowLight, color: yellow, label: 'Pending', icon: <Clock size={12} /> };
    }
  };

  const statsCards = [
    { label: 'Total Users', value: stats.totalUsers.toString(), delta: '+12%', icon: <Users size={20} /> },
    { label: 'Total Properties', value: stats.totalProperties.toString(), delta: '+8%', icon: <Building size={20} /> },
    { label: 'Active Listings', value: stats.activeListings.toString(), delta: '+5%', icon: <EyeIcon size={20} /> },
    { label: 'Pending Approval', value: stats.pendingApproval.toString(), delta: '+3', icon: <Clock size={20} /> },
  ];

  const sections = [
    { id: 'listings', label: 'Listing Approval & Info', icon: <CheckCircle size={18} /> },
    { id: 'homepageManager', label: 'Homepage Placements', icon: <Layout size={18} /> },
    { id: 'homepageEditor', label: 'Edit All Pages', icon: <Edit size={18} /> },
    { id: 'transportRequests', label: 'Moving Requests', icon: <Truck size={18} /> },
    { id: 'driverApprovals', label: 'Driver Approvals', icon: <UserCheck size={18} /> },
    { id: 'serviceRequests', label: 'Move-in Requests', icon: <Briefcase size={18} /> },
    { id: 'movingPackages', label: 'Moving Packages', icon: <Package size={18} /> },
    { id: 'agencyPackages', label: 'Agency Packages', icon: <Building2 size={18} /> },
    { id: 'sightseeingPackages', label: 'Sightseeing Packages', icon: <Compass size={18} /> },
    { id: 'whatsappControl', label: 'WhatsApp Control', icon: <MessageCircle size={18} /> },
    { id: 'users', label: 'User Management', icon: <Users size={18} /> },
    { id: 'allProperties', label: 'All Properties', icon: <Building size={18} /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart size={18} /> },
    { id: 'apiDomains', label: 'API Domains', icon: <Globe size={18} /> }
  ];

  const getCurrentListings = () => {
    switch(selectedStatus) {
      case 'pending': return pendingListings;
      case 'approved': return approvedListings;
      case 'rejected': return rejectedListings;
      default: return pendingListings;
    }
  };

  // Recursive tree renderer for Full Seller Info Modal
  const renderInfoTree = (obj) => {
    if (!obj || typeof obj !== 'object') return <span>{String(obj)}</span>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8 }}>
        {Object.entries(obj).map(([k, v]) => {
          if (k === 'id' || k === 'userId') return null;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            return (
              <div key={k} style={{ marginTop: 6, background: 'rgba(0,0,0,0.02)', padding: 8, borderRadius: 8 }}>
                <strong style={{ textTransform: 'capitalize', color: red }}>{k.replace(/([A-Z])/g, ' $1')}:</strong>
                {renderInfoTree(v)}
              </div>
            );
          }
          if (Array.isArray(v)) {
            return (
              <div key={k} style={{ marginTop: 6 }}>
                <strong style={{ textTransform: 'capitalize', color: red }}>{k.replace(/([A-Z])/g, ' $1')}:</strong>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {v.map((item, idx) => (
                    <span key={idx} style={{ background: 'rgba(0,0,0,0.05)', padding: '2px 8px', borderRadius: 12, fontSize: 11 }}>
                      {typeof item === 'object' ? JSON.stringify(item) : String(item)}
                    </span>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(0,0,0,0.03)', paddingBottom: 3 }}>
              <span style={{ color: ink2, textTransform: 'capitalize' }}>{k.replace(/([A-Z])/g, ' $1')}:</span>
              <span style={{ fontWeight: 500, textAlign: 'right' }}>{String(v)}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{
      background: 'linear-gradient(145deg, #fef2f2 0%, #fee2e2 30%, #fef2f2 60%, #fecaca 100%)',
      minHeight: '100vh',
      padding: '32px 40px 56px',
      fontFamily: sans,
      fontWeight: 300,
      color: ink,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: '8%', left: '18%', width: 340, height: 340, borderRadius: '50%', background: 'rgba(220,38,38,0.1)', filter: 'blur(60px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '12%', right: '14%', width: 280, height: 280, borderRadius: '50%', background: 'rgba(239,68,68,0.08)', filter: 'blur(50px)', pointerEvents: 'none' }} />

      <div style={{ width: '100%', position: 'relative', zIndex: 1 }}>
        {/* Navigation */}
        <nav style={{ ...glass, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', marginBottom: 24 }}>
          <div style={{ fontFamily: serif, fontSize: 22, fontWeight: 400, color: ink, letterSpacing: -0.2 }}>
            Admin <em style={{ fontStyle: 'italic', color: red }}>Control Center</em>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: red, opacity: 1 }} />
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: ink3, opacity: 0.35 }} />
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: ink3, opacity: 0.35 }} />
            <div style={{ fontFamily: sans, fontSize: 11, color: ink2, background: 'rgba(255,255,255,0.18)', border: `1px solid ${rule}`, borderRadius: 20, padding: '7px 16px' }}>
              {new Date().toLocaleDateString()}
            </div>
          </div>
        </nav>

        {/* Welcome Section */}
        <div style={{ ...glass, padding: '24px 28px', marginBottom: 24 }}>
          <div>
            <div style={{ fontFamily: serif, fontSize: 24, fontWeight: 400 }}>Listing Approval & Site Pages Publisher</div>
            <div style={{ fontSize: 13, color: ink2, marginTop: 4 }}>Review seller details, assign homepage placements, and edit all site pages (Home, Explore, About, Agents)</div>
          </div>
        </div>

        {/* Stats Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
          {statsCards.map((stat, idx) => (
            <div key={idx} style={{ ...glass, padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ background: redLight, borderRadius: 12, padding: '8px' }}>
                  {stat.icon}
                </div>
                <span style={{ fontSize: 11, color: green }}>{stat.delta}</span>
              </div>
              <div style={{ fontFamily: serif, fontSize: 32, fontWeight: 300 }}>{stat.value}</div>
              <div style={{ fontSize: 11, color: ink2 }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Section Tabs */}
        <div style={{ ...glass, display: 'flex', gap: 8, padding: '8px', marginBottom: 24, flexWrap: 'wrap' }}>
          {sections.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 20px',
                borderRadius: 12,
                background: activeSection === section.id ? red : 'transparent',
                color: activeSection === section.id ? 'white' : ink2,
                border: 'none',
                cursor: 'pointer',
                fontFamily: sans,
                fontSize: 13,
                transition: 'all 0.2s'
              }}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </div>

        {/* Listing Approval Section */}
        {activeSection === 'listings' && (
          <div style={{ ...glass, padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 16 }}>
              <div>
                <div style={{ fontFamily: serif, fontSize: 18, fontWeight: 500 }}>Seller Submission Queue</div>
                <div style={{ fontSize: 12, color: ink2 }}>Inspect all seller-submitted information and assign homepage placements</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setSelectedStatus('pending')}
                  style={{ padding: '8px 16px', borderRadius: 20, background: selectedStatus === 'pending' ? yellow : 'transparent', color: selectedStatus === 'pending' ? 'white' : ink2, border: `1px solid ${rule}`, cursor: 'pointer' }}
                >
                  Pending ({pendingListings.length})
                </button>
                <button
                  onClick={() => setSelectedStatus('approved')}
                  style={{ padding: '8px 16px', borderRadius: 20, background: selectedStatus === 'approved' ? green : 'transparent', color: selectedStatus === 'approved' ? 'white' : ink2, border: `1px solid ${rule}`, cursor: 'pointer' }}
                >
                  Approved ({approvedListings.length})
                </button>
                <button
                  onClick={() => setSelectedStatus('rejected')}
                  style={{ padding: '8px 16px', borderRadius: 20, background: selectedStatus === 'rejected' ? red : 'transparent', color: selectedStatus === 'rejected' ? 'white' : ink2, border: `1px solid ${rule}`, cursor: 'pointer' }}
                >
                  Rejected ({rejectedListings.length})
                </button>
              </div>
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', padding: 40 }}>
                <Loader size={32} className="animate-spin" style={{ color: red, margin: '0 auto' }} />
              </div>
            ) : getCurrentListings().length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: ink2 }}>
                <CheckCircle size={48} style={{ marginBottom: 16, opacity: 0.5 }} />
                <p>No {selectedStatus} listings found</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {getCurrentListings().map((listing) => {
                  const statusBadge = getStatusBadge(listing.verificationStatus || listing.approvalStatus || 'pending');
                  const primaryImage = resolvePropertyImage(listing);
                  return (
                    <div key={listing.id} style={{ background: 'rgba(255,255,255,0.38)', border: `1px solid ${rule}`, borderRadius: 16, padding: '16px' }}>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <img
                          src={primaryImage || '/images/property-hero.svg'}
                          alt={listing.title}
                          style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 12 }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                            <div>
                              <h3 style={{ fontFamily: serif, fontSize: 18, fontWeight: 500, marginBottom: 4 }}>{listing.title}</h3>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: ink2, flexWrap: 'wrap' }}>
                                <span><MapPin size={12} /> {listing.location}</span>
                                <span><Bed size={12} /> {listing.bedrooms || 0} beds</span>
                                <span><Bath size={12} /> {listing.bathrooms || 0} baths</span>
                                <span><Square size={12} /> {listing.area || 0} sqft</span>
                              </div>
                              <div style={{ fontSize: 11, color: ink3, marginTop: 4 }}>
                                Submitted by: {listing.userName || listing.userEmail || 'Seller'} ({listing.userType || 'seller'})
                              </div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontFamily: serif, fontSize: 20, fontWeight: 500, color: red }}>KES {listing.price?.toLocaleString()}</div>
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 20, background: statusBadge.bg, color: statusBadge.color, fontSize: 11, marginTop: 4 }}>
                                {statusBadge.icon} {statusBadge.label}
                              </div>
                            </div>
                          </div>

                          {listing.homepagePlacements?.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 11, color: ink3, alignSelf: 'center' }}>Homepage Sections:</span>
                              {listing.homepagePlacements.map(p => (
                                <span key={p} style={{ fontSize: 10, background: 'rgba(220,38,38,0.1)', color: red, padding: '2px 8px', borderRadius: 10, textTransform: 'capitalize' }}>
                                  {p}
                                </span>
                              ))}
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                            <button
                              onClick={() => { setSelectedPropertyInfo(listing); setShowInfoModal(true); }}
                              style={{ padding: '8px 16px', background: 'rgba(0,0,0,0.06)', color: ink, border: 'none', borderRadius: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                            >
                              <Info size={14} /> View All Seller Info
                            </button>

                            <button
                              onClick={() => setPromoteProperty(listing)}
                              style={{ padding: '8px 16px', background: greenLight, color: green, border: '1px solid rgba(16,185,129,0.35)', borderRadius: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                            >
                              <MessageCircle size={14} /> Promote
                            </button>

                            {listing.verificationStatus !== 'approved' && listing.approvalStatus !== 'approved' && (
                              <button
                                onClick={() => handleOpenApproval(listing.id)}
                                disabled={loading}
                                style={{ padding: '8px 16px', background: green, color: 'white', border: 'none', borderRadius: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                              >
                                <Check size={14} /> Approve & Publish
                              </button>
                            )}
                            {listing.verificationStatus !== 'rejected' && listing.approvalStatus !== 'rejected' && (
                              <button
                                onClick={() => handleRejectListing(listing.id)}
                                disabled={loading}
                                style={{ padding: '8px 16px', background: red, color: 'white', border: 'none', borderRadius: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                              >
                                <X size={14} /> Reject
                              </button>
                            )}
                            {(listing.verificationStatus === 'approved' || listing.approvalStatus === 'approved') && (
                              <button
                                onClick={() => handleRevokeApproval(listing.id)}
                                disabled={loading}
                                style={{ padding: '8px 16px', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                              >
                                <AlertCircle size={14} /> Revoke Approval
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteListing(listing.id)}
                              disabled={loading}
                              style={{ padding: '8px 16px', background: 'rgba(107,114,128,0.2)', color: ink2, border: 'none', borderRadius: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                            >
                              <Trash2 size={14} /> Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Homepage Placements Section */}
        {activeSection === 'homepageManager' && (
          <div style={{ ...glass, padding: '24px' }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: serif, fontSize: 18, fontWeight: 500 }}>Homepage Placement Manager</div>
              <div style={{ fontSize: 12, color: ink2 }}>Choose exactly where approved properties render on the homepage sections</div>
            </div>

            {approvedListings.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: ink2 }}>
                <Layout size={48} style={{ marginBottom: 12, opacity: 0.5 }} />
                <p>No approved listings available to manage.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {approvedListings.map((listing) => {
                  const currentPlacements = listing.homepagePlacements || ['featured', 'main'];
                  return (
                    <div key={listing.id} style={{ background: 'rgba(255,255,255,0.4)', padding: 16, borderRadius: 16, border: `1px solid ${rule}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <img src={resolvePropertyImage(listing) || '/images/property-hero.svg'} alt="" style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 8 }} />
                          <div>
                            <div style={{ fontWeight: 500, fontSize: 16 }}>{listing.title}</div>
                            <div style={{ fontSize: 12, color: ink2 }}>{listing.location} · KES {listing.price?.toLocaleString()}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, color: ink2 }}>Show on:</span>
                          {['featured', 'hero', 'trending', 'main'].map(sec => {
                            const isChecked = currentPlacements.includes(sec);
                            return (
                              <label key={sec} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', background: isChecked ? redLight : 'rgba(255,255,255,0.6)', padding: '6px 12px', borderRadius: 12, border: `1px solid ${isChecked ? red : rule}` }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const updated = e.target.checked
                                      ? [...currentPlacements, sec]
                                      : currentPlacements.filter(p => p !== sec);
                                    handleUpdatePlacements(listing.id, updated);
                                  }}
                                  style={{ accentColor: red }}
                                />
                                <span style={{ textTransform: 'capitalize', fontWeight: isChecked ? 500 : 400 }}>{sec}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Edit All Pages Section (Homepage, Explore, About, Agents) */}
        {activeSection === 'homepageEditor' && (
          <div style={{ ...glass, padding: '28px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
              <div>
                <div style={{ fontFamily: serif, fontSize: 20, fontWeight: 500 }}>Edit Site Pages Content</div>
                <div style={{ fontSize: 12, color: ink2 }}>Select a page to edit its title, hero text, and content</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { id: 'homepage', label: 'Homepage' },
                  { id: 'explore', label: 'Explore Page' },
                  { id: 'about', label: 'About Page' },
                  { id: 'agents', label: 'Agents Page' },
                  { id: 'custom', label: 'Custom Page' }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setEditorSubTab(tab.id)}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 12,
                      background: editorSubTab === tab.id ? red : 'rgba(255,255,255,0.6)',
                      color: editorSubTab === tab.id ? 'white' : ink2,
                      border: `1px solid ${editorSubTab === tab.id ? red : rule}`,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 500
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* HOMEPAGE EDITOR FORM */}
            {editorSubTab === 'homepage' && (
              <form onSubmit={handleSaveHomepageSettings} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ background: 'rgba(255,255,255,0.5)', padding: 20, borderRadius: 16, border: `1px solid ${rule}` }}>
                  <h3 style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, marginBottom: 12, color: red }}>Homepage Hero Section</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Hero Title</label>
                      <input
                        type="text"
                        value={homepageForm.hero.title}
                        onChange={(e) => setHomepageForm({...homepageForm, hero: {...homepageForm.hero, title: e.target.value}})}
                        style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Search Placeholder</label>
                      <input
                        type="text"
                        value={homepageForm.hero.searchPlaceholder}
                        onChange={(e) => setHomepageForm({...homepageForm, hero: {...homepageForm.hero, searchPlaceholder: e.target.value}})}
                        style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Hero Subtitle</label>
                    <textarea
                      rows="2"
                      value={homepageForm.hero.subtitle}
                      onChange={(e) => setHomepageForm({...homepageForm, hero: {...homepageForm.hero, subtitle: e.target.value}})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Default Hero Background Image URL</label>
                    <input
                      type="text"
                      value={homepageForm.hero.backgroundImage}
                      onChange={(e) => setHomepageForm({...homepageForm, hero: {...homepageForm.hero, backgroundImage: e.target.value}})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                </div>

                <div style={{ background: 'rgba(255,255,255,0.5)', padding: 20, borderRadius: 16, border: `1px solid ${rule}` }}>
                  <h3 style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, marginBottom: 12, color: red }}>Call to Action (CTA) Banner</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>CTA Title</label>
                      <input
                        type="text"
                        value={homepageForm.cta.title}
                        onChange={(e) => setHomepageForm({...homepageForm, cta: {...homepageForm.cta, title: e.target.value}})}
                        style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Button 1 Text</label>
                      <input
                        type="text"
                        value={homepageForm.cta.button1Text}
                        onChange={(e) => setHomepageForm({...homepageForm, cta: {...homepageForm.cta, button1Text: e.target.value}})}
                        style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                      />
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>CTA Subtitle</label>
                    <textarea
                      rows="2"
                      value={homepageForm.cta.subtitle}
                      onChange={(e) => setHomepageForm({...homepageForm, cta: {...homepageForm.cta, subtitle: e.target.value}})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                </div>

                <div>
                  <button
                    type="submit"
                    disabled={loading}
                    style={{ padding: '12px 28px', background: red, color: 'white', border: 'none', borderRadius: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Save size={16} /> {loading ? 'Saving...' : 'Save Homepage Changes'}
                  </button>
                </div>
              </form>
            )}

            {/* EXPLORE PAGE EDITOR FORM */}
            {editorSubTab === 'explore' && (
              <form onSubmit={handleSaveExploreSettings} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ background: 'rgba(255,255,255,0.5)', padding: 20, borderRadius: 16, border: `1px solid ${rule}` }}>
                  <h3 style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, marginBottom: 12, color: red }}>Explore Page Header</h3>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page Title</label>
                    <input
                      type="text"
                      value={exploreForm.title}
                      onChange={(e) => setExploreForm({...exploreForm, title: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page Subtitle</label>
                    <textarea
                      rows="3"
                      value={exploreForm.subtitle}
                      onChange={(e) => setExploreForm({...exploreForm, subtitle: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                </div>

                <div>
                  <button
                    type="submit"
                    disabled={loading}
                    style={{ padding: '12px 28px', background: red, color: 'white', border: 'none', borderRadius: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Save size={16} /> {loading ? 'Saving...' : 'Save Explore Page Changes'}
                  </button>
                </div>
              </form>
            )}

            {/* ABOUT PAGE EDITOR FORM */}
            {editorSubTab === 'about' && (
              <form onSubmit={handleSaveAboutSettings} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ background: 'rgba(255,255,255,0.5)', padding: 20, borderRadius: 16, border: `1px solid ${rule}` }}>
                  <h3 style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, marginBottom: 12, color: red }}>About Page Content</h3>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page Title</label>
                    <input
                      type="text"
                      value={aboutForm.title}
                      onChange={(e) => setAboutForm({...aboutForm, title: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Subtitle</label>
                    <input
                      type="text"
                      value={aboutForm.subtitle}
                      onChange={(e) => setAboutForm({...aboutForm, subtitle: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Company Story & Mission</label>
                    <textarea
                      rows="6"
                      value={aboutForm.story}
                      onChange={(e) => setAboutForm({...aboutForm, story: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                </div>

                <div>
                  <button
                    type="submit"
                    disabled={loading}
                    style={{ padding: '12px 28px', background: red, color: 'white', border: 'none', borderRadius: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Save size={16} /> {loading ? 'Saving...' : 'Save About Page Changes'}
                  </button>
                </div>
              </form>
            )}

            {/* AGENTS PAGE EDITOR FORM */}
            {editorSubTab === 'agents' && (
              <form onSubmit={handleSaveAgentsSettings} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ background: 'rgba(255,255,255,0.5)', padding: 20, borderRadius: 16, border: `1px solid ${rule}` }}>
                  <h3 style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, marginBottom: 12, color: red }}>Agents Page Header & CTA</h3>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page Title</label>
                    <input
                      type="text"
                      value={agentsForm.title}
                      onChange={(e) => setAgentsForm({...agentsForm, title: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page Subtitle</label>
                    <textarea
                      rows="2"
                      value={agentsForm.subtitle}
                      onChange={(e) => setAgentsForm({...agentsForm, subtitle: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Join Team CTA Title</label>
                    <input
                      type="text"
                      value={agentsForm.ctaTitle}
                      onChange={(e) => setAgentsForm({...agentsForm, ctaTitle: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Join Team CTA Subtitle</label>
                    <textarea
                      rows="2"
                      value={agentsForm.ctaSubtitle}
                      onChange={(e) => setAgentsForm({...agentsForm, ctaSubtitle: e.target.value})}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                </div>

                <div>
                  <button
                    type="submit"
                    disabled={loading}
                    style={{ padding: '12px 28px', background: red, color: 'white', border: 'none', borderRadius: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Save size={16} /> {loading ? 'Saving...' : 'Save Agents Page Changes'}
                  </button>
                </div>
              </form>
            )}

            {editorSubTab === 'custom' && (
              <form onSubmit={handleSaveCustomPageSettings} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ background: 'rgba(255,255,255,0.5)', padding: 20, borderRadius: 16, border: `1px solid ${rule}` }}>
                  <h3 style={{ fontFamily: serif, fontSize: 16, fontWeight: 600, marginBottom: 12, color: red }}>Custom Page Editor</h3>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page slug</label>
                    <input
                      type="text"
                      value={customPageSlug}
                      onChange={(e) => setCustomPageSlug(e.target.value.trim() || 'homepage')}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff' }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                    <button
                      type="button"
                      onClick={() => handleLoadCustomPage(customPageSlug)}
                      style={{ padding: '8px 12px', borderRadius: 10, border: `1px solid ${rule}`, background: 'rgba(255,255,255,0.8)', color: ink2, cursor: 'pointer' }}
                    >
                      Load page
                    </button>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>Page JSON</label>
                    <textarea
                      rows="18"
                      value={customPageJson}
                      onChange={(e) => setCustomPageJson(e.target.value)}
                      style={{ width: '100%', padding: '12px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
                    />
                  </div>
                </div>

                <div>
                  <button
                    type="submit"
                    disabled={loading}
                    style={{ padding: '12px 28px', background: red, color: 'white', border: 'none', borderRadius: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <Save size={16} /> {loading ? 'Saving...' : 'Save Custom Page'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Users Section */}
        {activeSection === 'users' && (
          <div style={{ ...glass, padding: '24px' }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: serif, fontSize: 18, fontWeight: 500 }}>User Management</div>
              <div style={{ fontSize: 12, color: ink2 }}>Manage users, agents, sellers, and staff access</div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {['all', ...roles.map(role => role.value)].map(roleValue => {
                  const roleMeta = roles.find(role => role.value === roleValue) || { label: 'All Users', value: 'all' };
                  const count = roleValue === 'all' ? users.length : users.filter(user => (user.role || 'user') === roleValue).length;
                  return (
                    <button
                      key={roleValue}
                      onClick={() => setSelectedRole(roleValue)}
                      style={{
                        padding: '8px 12px',
                        borderRadius: 20,
                        border: '1px solid rgba(255,255,255,0.2)',
                        background: selectedRole === roleValue ? red : 'rgba(255,255,255,0.15)',
                        color: selectedRole === roleValue ? 'white' : ink2,
                        cursor: 'pointer',
                        fontSize: 11,
                        fontWeight: 500,
                      }}
                    >
                      {roleMeta.label} ({count})
                    </button>
                  );
                })}
              </div>

              <div style={{ minWidth: 220, flex: 1, maxWidth: 340 }}>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search user name or email"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 12, border: `1px solid ${rule}`, background: 'rgba(255,255,255,0.5)', color: ink }}
                />
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${rule}` }}>
                    <th style={{ textAlign: 'left', padding: '12px', fontSize: 11, fontWeight: 500, color: ink3 }}>User</th>
                    <th style={{ textAlign: 'left', padding: '12px', fontSize: 11, fontWeight: 500, color: ink3 }}>Contact</th>
                    <th style={{ textAlign: 'left', padding: '12px', fontSize: 11, fontWeight: 500, color: ink3 }}>Role</th>
                    <th style={{ textAlign: 'right', padding: '12px', fontSize: 11, fontWeight: 500, color: ink3 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.slice(0, 15).map((user) => (
                    <tr key={user.id} style={{ borderBottom: `1px solid ${rule}` }}>
                      <td style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 36, height: 36, borderRadius: '50%', background: `linear-gradient(135deg, ${red}, #ef4444)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold' }}>
                            {user.name?.charAt(0) || user.email?.charAt(0) || 'U'}
                          </div>
                          <div>
                            <div style={{ fontWeight: 500 }}>{user.name || 'No Name'}</div>
                            <div style={{ fontSize: 11, color: ink3 }}>{user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '12px' }}>
                        <div style={{ fontSize: 11, color: ink2 }}>{user.phone || 'No phone'}</div>
                      </td>
                      <td style={{ padding: '12px' }}>
                        <select
                          value={user.role || 'user'}
                          onChange={(e) => handleUpdateUserRole(user.id, e.target.value)}
                          style={{ padding: '4px 8px', borderRadius: 12, fontSize: 11, border: `1px solid ${rule}` }}
                        >
                          {roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '12px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                          {(user.role === 'agent' || user.role === 'seller') && (
                            <button onClick={() => openAgentProfileEditor(user)} style={{ padding: 6, background: 'rgba(59,130,246,0.12)', border: 'none', borderRadius: 8, cursor: 'pointer', color: '#2563eb' }}>
                              <UserCheck size={14} />
                            </button>
                          )}
                          <button onClick={() => handleDeleteUser(user.id, user.name || user.email)} style={{ padding: 6, background: redLight, border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                            <Trash2 size={14} color={red} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredUsers.length === 0 && (
                <div style={{ padding: '24px 12px', textAlign: 'center', color: ink2 }}>
                  No users found for this role or search.
                </div>
              )}
            </div>
          </div>
        )}

        {/* All Properties Section */}
        {activeSection === 'allProperties' && (
          <div style={{ ...glass, padding: '24px' }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: serif, fontSize: 18, fontWeight: 500 }}>All Properties</div>
              <div style={{ fontSize: 12, color: ink2 }}>Complete list of all property listings in database</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
              {properties.map((property) => (
                <div key={property.id} style={{ background: 'rgba(255,255,255,0.38)', border: `1px solid ${rule}`, borderRadius: 12, overflow: 'hidden' }}>
                  <img src={resolvePropertyImage(property) || '/images/property-hero.svg'} alt={property.title} style={{ width: '100%', height: 150, objectFit: 'cover' }} />
                  <div style={{ padding: 12 }}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{property.title}</div>
                    <div style={{ fontSize: 11, color: ink2 }}>{property.location}</div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: red, marginTop: 4 }}>KES {property.price?.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: ink3, marginTop: 4 }}>Status: {property.verificationStatus || property.approvalStatus || 'pending'}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {showAgentProfileModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 1000 }}>
            <div style={{ width: '100%', maxWidth: 620, maxHeight: '85vh', overflowY: 'auto', background: '#fff', borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <div>
                  <div style={{ fontFamily: serif, fontSize: 20, fontWeight: 600, color: red }}>Agent Profile</div>
                  <div style={{ fontSize: 12, color: ink2 }}>Update the account profile associated with this agent login email.</div>
                </div>
                <button onClick={() => setShowAgentProfileModal(false)} style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: ink2 }}>×</button>
              </div>

              <form onSubmit={handleSaveAgentProfile} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Full name</label>
                  <input value={agentProfileDraft.name} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, name: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Login email</label>
                  <input value={agentProfileDraft.email} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, email: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Phone</label>
                  <input value={agentProfileDraft.phone} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, phone: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Role title</label>
                  <input value={agentProfileDraft.title} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, title: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Photo URL</label>
                  <input value={agentProfileDraft.photo} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, photo: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Bio</label>
                  <textarea rows="3" value={agentProfileDraft.bio} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, bio: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Specialties</label>
                  <input value={agentProfileDraft.specialties.join(', ')} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, specialties: e.target.value.split(',').map(item => item.trim()).filter(Boolean) })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Languages</label>
                  <input value={agentProfileDraft.languages.join(', ')} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, languages: e.target.value.split(',').map(item => item.trim()).filter(Boolean) })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Experience (years)</label>
                  <input type="number" value={agentProfileDraft.experience} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, experience: Number(e.target.value || 1) })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Rating</label>
                  <input type="number" step="0.1" min="0" max="5" value={agentProfileDraft.rating} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, rating: Number(e.target.value || 4.8) })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Properties sold</label>
                  <input type="number" value={agentProfileDraft.propertiesSold} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, propertiesSold: Number(e.target.value || 0) })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, marginBottom: 6, color: ink2 }}>Office / branch</label>
                  <input value={agentProfileDraft.office} onChange={(e) => setAgentProfileDraft({ ...agentProfileDraft, office: e.target.value })} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #d1d5db' }} />
                </div>

                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                  <button type="button" onClick={() => setShowAgentProfileModal(false)} style={{ padding: '10px 18px', borderRadius: 12, border: `1px solid ${rule}`, background: '#fff', color: ink2, cursor: 'pointer' }}>Cancel</button>
                  <button type="submit" style={{ padding: '10px 18px', borderRadius: 12, border: 'none', background: red, color: '#fff', cursor: 'pointer' }}>Save agent profile</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Analytics Section */}
        {activeSection === 'transportRequests' && <TransportRequestsPage />}
        {activeSection === 'driverApprovals' && (
          <div style={{ ...glass, padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
              <div>
                <div style={{ fontFamily: serif, fontSize: 20, fontWeight: 500 }}>Driver Approvals</div>
                <div style={{ fontSize: 12, color: ink2, marginTop: 4 }}>
                  Drivers self-register at <a href="/driver/onboard" target="_blank" rel="noreferrer" style={{ color: red, fontWeight: 600, textDecoration: 'underline' }}>/driver/onboard</a>. Review vehicle + license, then approve or reject.
                </div>
              </div>
              <button type="button" onClick={loadDrivers} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 12, background: '#fff', color: ink2, border: `1px solid ${rule}`, cursor: 'pointer' }}>
                <RefreshCw size={15} /> Refresh
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
              {[
                { id: 'pending', label: 'Pending', count: allDrivers.filter(d => d.driverStatus !== 'approved' && d.driverStatus !== 'rejected').length },
                { id: 'approved', label: 'Approved', count: allDrivers.filter(d => d.driverStatus === 'approved' || d.driverApproved === true).length },
                { id: 'rejected', label: 'Rejected', count: allDrivers.filter(d => d.driverStatus === 'rejected').length },
                { id: 'all', label: 'All', count: allDrivers.length },
              ].map(tab => (
                <button key={tab.id} onClick={() => setDriverFilter(tab.id)} style={{ padding: '8px 16px', borderRadius: 20, background: driverFilter === tab.id ? red : 'transparent', color: driverFilter === tab.id ? 'white' : ink2, border: `1px solid ${driverFilter === tab.id ? red : rule}`, cursor: 'pointer', fontSize: 12, fontWeight: 500 }}>
                  {tab.label} · {tab.count}
                </button>
              ))}
            </div>

            {(() => {
              const visible = allDrivers.filter(d => {
                if (driverFilter === 'all') return true;
                if (driverFilter === 'approved') return d.driverStatus === 'approved' || d.driverApproved === true;
                if (driverFilter === 'rejected') return d.driverStatus === 'rejected';
                return d.driverStatus !== 'approved' && d.driverStatus !== 'rejected' && d.driverApproved !== true;
              });

              if (!visible.length) return (
                <div style={{ padding: 40, textAlign: 'center', color: ink2, border: `1px dashed ${rule}`, borderRadius: 16 }}>
                  <UserCheck size={40} style={{ opacity: 0.4, marginBottom: 12 }} />
                  <p style={{ margin: 0 }}>No {driverFilter} driver applications.</p>
                </div>
              );

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {visible.map(driver => {
                    const profile = driver.driverProfile || {};
                    const status = driver.driverApproved === true || driver.driverStatus === 'approved' ? 'approved' : driver.driverStatus === 'rejected' ? 'rejected' : 'pending';
                    const badge = status === 'approved' ? { bg: greenLight, color: green, label: 'Approved' } : status === 'rejected' ? { bg: redLight, color: red, label: 'Rejected' } : { bg: yellowLight, color: yellow, label: 'Pending review' };
                    return (
                      <div key={driver.id} style={{ background: 'rgba(255,255,255,0.55)', border: `1px solid ${rule}`, borderRadius: 16, padding: 16, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <div style={{ width: 56, height: 56, borderRadius: '50%', background: `linear-gradient(135deg, ${red}, #ef4444)`, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 20, flex: '0 0 auto' }}>
                          {(driver.name || driver.email || 'D').charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, fontSize: 15 }}>{driver.name || 'No name'}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 10, background: badge.bg, color: badge.color, textTransform: 'uppercase', letterSpacing: 0.4 }}>{badge.label}</span>
                          </div>
                          <div style={{ fontSize: 12, color: ink2, marginTop: 3 }}>{driver.email || '—'} · {profile.phone || driver.phone || '—'}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
                            <div style={{ background: 'rgba(0,0,0,0.03)', padding: '8px 10px', borderRadius: 10 }}>
                              <div style={{ fontSize: 10, color: ink3, textTransform: 'uppercase', letterSpacing: 0.4 }}>Vehicle</div>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{profile.vehicleId || '—'}</div>
                            </div>
                            <div style={{ background: 'rgba(0,0,0,0.03)', padding: '8px 10px', borderRadius: 10 }}>
                              <div style={{ fontSize: 10, color: ink3, textTransform: 'uppercase', letterSpacing: 0.4 }}>Plate</div>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{profile.plate || '—'}</div>
                            </div>
                            <div style={{ background: 'rgba(0,0,0,0.03)', padding: '8px 10px', borderRadius: 10 }}>
                              <div style={{ fontSize: 10, color: ink3, textTransform: 'uppercase', letterSpacing: 0.4 }}>License</div>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{profile.licenseNumber || '—'}</div>
                            </div>
                          </div>
                          {driver.driverRejectionReason && status === 'rejected' && (
                            <div style={{ marginTop: 10, fontSize: 12, color: red, background: redLight, padding: '6px 10px', borderRadius: 8 }}>Reason: {driver.driverRejectionReason}</div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
                          {status !== 'approved' && (
                            <button onClick={() => handleDriverDecision(driver, 'approve')} disabled={driverSavingId === driver.id} style={{ padding: '9px 16px', background: green, color: '#fff', border: 'none', borderRadius: 12, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: driverSavingId === driver.id ? 0.6 : 1 }}>{driverSavingId === driver.id ? 'Working…' : 'Approve'}</button>
                          )}
                          {status !== 'rejected' && (
                            <button onClick={() => handleDriverDecision(driver, 'reject')} disabled={driverSavingId === driver.id} style={{ padding: '9px 16px', background: red, color: '#fff', border: 'none', borderRadius: 12, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: driverSavingId === driver.id ? 0.6 : 1 }}>Reject</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {activeSection === 'serviceRequests' && <AdminServiceRequestsPage />}
        {activeSection === 'movingPackages' && <MovingPackagesPage />}
        {activeSection === 'agencyPackages' && <AgencyPackagesPage />}
        {activeSection === 'sightseeingPackages' && <SightseeingPackagesPage />}
        {activeSection === 'whatsappControl' && <WhatsAppControl />}

        {activeSection === 'analytics' && (
          <div style={{ ...glass, padding: '24px', textAlign: 'center' }}>
            <BarChart size={48} style={{ margin: '40px auto 16px', opacity: 0.5 }} />
            <div style={{ fontFamily: serif, fontSize: 18, fontWeight: 500, marginBottom: 8 }}>Analytics Dashboard</div>
            <div style={{ fontSize: 13, color: ink2 }}>Platform metrics, inquiries, and revenue overview.</div>
          </div>
        )}

        {activeSection === 'apiDomains' && (
          <div style={{ ...glass, padding: '24px', maxWidth: 900 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
              <div>
                <div style={{ fontFamily: serif, fontSize: 20, fontWeight: 500 }}>YouTube API Website Domains</div>
                <div style={{ fontSize: 12, color: ink2, marginTop: 4 }}>
                  Control which MarketMix websites may call the video API. Changes apply immediately.
                </div>
              </div>
              <button
                type="button"
                onClick={loadAllowedOrigins}
                disabled={originLoading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 12, background: '#fff', color: ink2, border: `1px solid ${rule}`, cursor: originLoading ? 'wait' : 'pointer' }}
              >
                <RefreshCw size={15} className={originLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
              <a href={`${YOUTUBE_ADMIN_API}/health`} target="_blank" rel="noreferrer" style={{ color: red, fontSize: 12, fontWeight: 600 }}>
                Open YouTube API health
              </a>
              <span style={{ color: ink3, fontSize: 12 }}>{YOUTUBE_ADMIN_API}</span>
            </div>

            <form onSubmit={handleAddOrigin} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              <input
                type="url"
                value={originInput}
                onChange={(event) => setOriginInput(event.target.value)}
                placeholder="https://your-new-domain.com"
                aria-label="Website origin to allow"
                style={{ flex: '1 1 280px', minWidth: 0, padding: '11px 12px', border: '1px solid #d1d5db', borderRadius: 10, background: '#fff', fontSize: 13 }}
              />
              <button type="submit" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', border: 0, borderRadius: 10, background: red, color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
                <Plus size={16} /> Add domain
              </button>
            </form>

            <div style={{ fontSize: 11, color: ink3, marginBottom: 16 }}>
              Enter the origin only: HTTPS scheme and domain, with no page path. Localhost is allowed for local development.
            </div>

            {originError && (
              <div role="alert" style={{ marginBottom: 16, padding: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, fontSize: 12 }}>
                {originError}
              </div>
            )}

            {originLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: ink2, padding: 18 }}>
                <Loader size={16} className="animate-spin" /> Loading allowed domains…
              </div>
            ) : allowedOrigins.length === 0 ? (
              <div style={{ padding: 18, border: `1px dashed ${rule}`, borderRadius: 12, color: ink2, fontSize: 13 }}>
                No domains loaded. Check the YouTube server connection and Firebase admin credentials.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {allowedOrigins.map((origin) => (
                  <div key={origin} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 12px', border: `1px solid ${rule}`, borderRadius: 10, background: 'rgba(255,255,255,0.65)' }}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: ink, fontSize: 13 }}>{origin}</span>
                    <button
                      type="button"
                      onClick={() => setAllowedOrigins((origins) => origins.filter((item) => item !== origin))}
                      aria-label={`Remove ${origin}`}
                      title="Remove domain"
                      style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, border: 0, borderRadius: 8, background: redLight, color: red, cursor: 'pointer' }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                type="button"
                onClick={handleSaveOrigins}
                disabled={originLoading || originSaving}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 18px', border: 0, borderRadius: 12, background: green, color: '#fff', fontWeight: 600, cursor: originSaving ? 'wait' : 'pointer', opacity: originLoading || originSaving ? 0.6 : 1 }}
              >
                {originSaving ? <Loader size={15} className="animate-spin" /> : <Save size={15} />}
                {originSaving ? 'Saving…' : 'Save domains'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* FULL SELLER INFO MODAL */}
      {showInfoModal && selectedPropertyInfo && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 20, maxWidth: 700, width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 30, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e5e7eb', paddingBottom: 16, marginBottom: 20 }}>
              <div>
                <h2 style={{ fontFamily: serif, fontSize: 22, fontWeight: 600 }}>Complete Seller Submission Info</h2>
                <p style={{ fontSize: 12, color: ink2 }}>All data provided by seller for review before approval</p>
              </div>
              <button onClick={() => setShowInfoModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                <X size={20} />
              </button>
            </div>

            {selectedPropertyInfo.images?.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: ink }}>Uploaded Photos ({selectedPropertyInfo.images.length})</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
                  {selectedPropertyInfo.images.map((imgUrl, i) => (
                    <img key={i} src={imgUrl} alt="" style={{ width: '100px', height: 80, objectFit: 'cover', borderRadius: 8 }} />
                  ))}
                </div>
              </div>
            )}

            <div style={{ background: '#f9fafb', borderRadius: 12, padding: 16, border: '1px solid #e5e7eb' }}>
              {renderInfoTree(selectedPropertyInfo)}
            </div>

            <div style={{ marginTop: 24, textAlign: 'right' }}>
              <button
                onClick={() => setShowInfoModal(false)}
                style={{ background: red, color: '#fff', border: 'none', borderRadius: 12, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* APPROVAL WITH HOMEPAGE PLACEMENT MODAL */}
      {showApprovalModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 20, maxWidth: 500, width: '100%', padding: 30, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e5e7eb', paddingBottom: 16, marginBottom: 20 }}>
              <h2 style={{ fontFamily: serif, fontSize: 20, fontWeight: 600 }}>Approve & Choose Homepage Placements</h2>
              <button onClick={() => setShowApprovalModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                <X size={20} />
              </button>
            </div>

            <p style={{ fontSize: 13, color: ink2, marginBottom: 16 }}>
              Select where this property should be rendered on the homepage after approval:
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
              {[
                { id: 'featured', label: '🌟 Featured Properties Section', desc: 'Display in the main featured properties grid on homepage' },
                { id: 'hero', label: '🚀 Hero Banner / Spotlight', desc: 'Highlight in the top hero showcase banner' },
                { id: 'trending', label: '🔥 Trending & Popular', desc: 'Show in trending/popular section' },
                { id: 'main', label: '🏠 General Main Feed', desc: 'Show in general listing feeds and explore page' },
              ].map(item => {
                const checked = selectedPlacements.includes(item.id);
                return (
                  <label key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: checked ? 'rgba(220,38,38,0.04)' : '#f9fafb', border: `1px solid ${checked ? red : '#e5e7eb'}`, padding: 12, borderRadius: 12, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setSelectedPlacements(
                          e.target.checked
                            ? [...selectedPlacements, item.id]
                            : selectedPlacements.filter(p => p !== item.id)
                        );
                      }}
                      style={{ marginTop: 2, accentColor: red }}
                    />
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{item.label}</div>
                      <div style={{ fontSize: 11, color: ink2, marginTop: 2 }}>{item.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button
                onClick={() => setShowApprovalModal(false)}
                style={{ background: 'transparent', color: ink, border: '1px solid #d1d5db', borderRadius: 12, padding: '10px 20px', fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmApproval}
                disabled={loading || selectedPlacements.length === 0}
                style={{ background: green, color: '#fff', border: 'none', borderRadius: 12, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}
              >
                {loading ? 'Approving...' : 'Confirm & Publish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;

ADMIN@DESKTOP-2NOEEN2 MINGW64 ~/Desktop/marketmix real estate/marketmix-realestates (main)
$
