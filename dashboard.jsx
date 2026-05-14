import React from 'react';
import { Box, H2, Text, Icon } from '@adminjs/design-system';

const features = [
  {
    title: 'Users',
    description: 'Manage buyer and seller identities, verify accounts, and handle roles.',
    icon: 'Users',
    color: '#3b82f6', // Blue
    link: '/admin/resources/users'
  },
  {
    title: 'Gift Cards',
    description: 'Review pending card listings, approve inventory, and browse active catalog.',
    icon: 'Gift',
    color: '#ea580c', // Orange
    link: '/admin/resources/cards'
  },
  {
    title: 'Payments',
    description: 'Monitor escrow transactions, handle disputes, and release funds to sellers.',
    icon: 'CreditCard',
    color: '#10b981', // Emerald
    link: '/admin/resources/payments'
  },
  {
    title: 'Platform Profits',
    description: 'Track admin revenue, analyze statistics, and withdraw available profit.',
    icon: 'BarChart',
    color: '#8b5cf6', // Violet
    link: '/admin/resources/platform_profits'
  },
  {
    title: 'Audit Logs',
    description: 'Review system activity, track admin actions, and maintain security compliance.',
    icon: 'Activity',
    color: '#64748b', // Slate
    link: '/admin/resources/audit_logs'
  }
];

const Dashboard = () => {
  return (
    <Box variant="grey" style={{ padding: '40px', minHeight: '100vh', backgroundColor: '#f8fafc' }}>
      <Box style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Header Section */}
        <Box mb="xxl">
          <H2 style={{ color: '#0f172a', fontWeight: '800', fontSize: '32px', marginBottom: '8px' }}>
            Welcome to Cards2Crypto
          </H2>
          <Text style={{ color: '#64748b', fontSize: '16px' }}>
            Your central command center for marketplace operations.
          </Text>
        </Box>

        {/* Grid Section */}
        <Box style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', 
          gap: '24px' 
        }}>
          {features.map((feature, idx) => (
            <a 
              key={idx} 
              href={feature.link}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <Box 
                variant="white" 
                p="xl" 
                style={{
                  borderRadius: '16px',
                  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
                  border: '1px solid #e2e8f0',
                  transition: 'all 0.3s ease',
                  cursor: 'pointer',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  backgroundColor: '#ffffff'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-4px)';
                  e.currentTarget.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)';
                  e.currentTarget.style.borderColor = feature.color;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)';
                  e.currentTarget.style.borderColor = '#e2e8f0';
                }}
              >
                <Box style={{ 
                  backgroundColor: `${feature.color}15`, 
                  width: '48px', 
                  height: '48px', 
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '20px'
                }}>
                  <Icon icon={feature.icon} size={24} color={feature.color} />
                </Box>
                
                <Text style={{ fontWeight: '700', fontSize: '18px', color: '#1e293b', marginBottom: '8px' }}>
                  {feature.title}
                </Text>
                
                <Text style={{ color: '#64748b', fontSize: '14px', lineHeight: '1.5', flexGrow: 1 }}>
                  {feature.description}
                </Text>

                <Box style={{ 
                  marginTop: '20px', 
                  display: 'flex', 
                  alignItems: 'center', 
                  color: feature.color,
                  fontWeight: '600',
                  fontSize: '14px'
                }}>
                  Manage {feature.title} <Icon icon="ArrowRight" size={16} style={{ marginLeft: '4px' }} />
                </Box>
              </Box>
            </a>
          ))}
        </Box>
        
        {/* Footer/Extra Info */}
        <Box mt="xxl" p="xl" style={{ 
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', 
          borderRadius: '16px',
          color: 'white',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)'
        }}>
          <Box>
            <Text style={{ fontWeight: 'bold', fontSize: '20px', marginBottom: '4px' }}>System Status: Operational</Text>
            <Text style={{ color: '#94a3b8', fontSize: '14px' }}>All smart contracts and API endpoints are functioning normally.</Text>
          </Box>
          <Icon icon="CheckCircle" size={48} color="#10b981" />
        </Box>

      </Box>
    </Box>
  );
};

export default Dashboard;
